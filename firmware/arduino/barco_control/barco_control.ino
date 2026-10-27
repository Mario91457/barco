/**
 * BARCO RC — modos Simple y Avanzado con MPU6500 y control de rumbo PID.
 *
 * Hardware (Arduino Uno / ATmega328P):
 *   HC-06 TXD -> D5 (RX de NeoSWSerial)
 *   HC-06 RXD <- D6 (TX de NeoSWSerial)
 *   ESC/motor -> D9 (OC1A, PWM por hardware Timer1)
 *   Servo de dirección -> D10 (OC1B, PWM por hardware Timer1)
 *   MPU6500 SDA -> A4, SCL -> A5, I2C 0x68 (cambiar a 0x69 si AD0 está alto)
 *   GND común entre Arduino, HC-06, ESC y servo.
 *
 * Protocolo app -> Arduino:
 *   Simple: F / S / L / G / R / H como caracteres sueltos, sin LF/CR y sin checksum
 *           (compatibilidad con Arduino Bluetooth Control / Car Controller).
 *           C (suelto) centra la dirección.
 *   Avanzado: líneas "<orden>*<HH>\n", donde HH es el XOR de los bytes de <orden>
 *           en dos dígitos hexadecimales mayúsculas. Si el checksum falta o no
 *           coincide, la línea se descarta (ver REQUIRE_LINE_CHECKSUM).
 *   Órdenes de línea:
 *     P0..P180          : potencia del motor (limitada por PMAX)
 *     D0..D180          : posición del servo en modo Avanzado
 *     PID,0 / PID,1     : desactivar/activar PID
 *     CRU,0 / CRU,1     : desactivar/activar mantenimiento del rumbo relativo
 *     HOLD              : al soltar el timón en crucero, capturar el yaw actual
 *     KP,n / KI,n / KD,n: ajustar ganancias del PID
 *     CAL               : detener el motor y recalibrar el bias del gyro Z
 *     TEL,0 / TEL,1     : desactivar/activar telemetría combinada
 *     ANG,c,b,e         : calibración del servo de la app (centro, babor, estribor;
 *                         0..180). Se usa en C/F/L/R/HOLD/failsafe y en el PID.
 *     PMAX,n            : tope de potencia 1..180 (la app envía su "velocidad máxima")
 *   ANG y PMAX no renuevan el failsafe; la app los reenvía periódicamente.
 *   Telemetría: T,yaw,pitch,roll,velocidad_en_décimas_m_s\n
 *
 * CONVENCIÓN DE SIGNOS (verificar con la prueba de banco del README):
 *   yaw  > 0 = la proa gira a estribor (sentido horario visto desde arriba).
 *   pitch> 0 = proa arriba.       roll > 0 = estribor abajo.
 *   Si el montaje del MPU invierte alguno, cambiar MPU_YAW_SIGN / MPU_PITCH_SIGN /
 *   MPU_ROLL_SIGN más abajo (no tocar las fórmulas).
 *
 * LIMITACIONES:
 *   El MPU6500 no tiene magnetómetro: el yaw relativo integra gyro Z y deriva.
 *   Pitch/roll se estiman con la gravedad del acelerómetro, calibrando la posición
 *   inicial como cero; las olas y aceleraciones pueden sesgar dichos ángulos.
 *   La velocidad integra aceleración longitudinal y deriva; no es una medición GPS
 *   y, al no compensar la gravedad, inclinar el casco la altera (limitación conocida).
 *
 * PWM:
 *   D9/D10 usan Fast PWM de Timer1 a 50 Hz, sin la biblioteca Servo ni su ISR.
 *   Timer1 queda reservado: no usar Servo ni analogWrite() en D9/D10.
 *
 * SEGURIDAD:
 *   Probar primero SIN hélice. El pulso ESC de parada y el intervalo de armado
 *   son configurables más abajo; verificar los valores requeridos por el modelo
 *   exacto de ESC (ESC_BIDIRECTIONAL).
 *   Como Timer1 mantiene el último pulso aunque el programa se cuelgue, el
 *   watchdog del AVR (WATCHDOG_TIMEOUT) reinicia la placa si loop() deja de
 *   ejecutarse (p. ej. bus I2C bloqueado) y al arrancar el pulso vuelve a parada.
 *   Un reinicio por watchdog repite armado y calibración del gyro (~7 s).
 */

#include <Wire.h>
#include <avr/io.h>
#include <avr/wdt.h>
#include <NeoSWSerial.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

// -----------------------------------------------------------------------------
// Configuración ajustable (pines, protocolo y seguridad)
// -----------------------------------------------------------------------------
#define DEBUG 0

#define PIN_BT_RX 5
#define PIN_BT_TX 6
#define PIN_ESC 9
#define PIN_SERVO_DIRECCION 10

#define BT_BAUD 9600
#define USB_SERIAL_BAUD 9600
#define MPU_I2C_ADDRESS 0x68

// ESC unidireccional (parada = 1000 us) o bidireccional (neutro = 1500 us; solo se
// usa el tramo de avance 1500..2000, nunca marcha atrás). Verificar con el ESC real.
#define ESC_BIDIRECTIONAL 0
#if ESC_BIDIRECTIONAL
  #define ESC_STOP_US 1500
  #define ESC_MIN_ACTIVE_US 1550
#else
  #define ESC_STOP_US 1000          // Pulso mínimo habitual para parar/armar muchos ESC
  #define ESC_MIN_ACTIVE_US 1050    // Pulso mínimo al recibir una orden de potencia > 0
#endif
#define ESC_MAX_US 2000           // Pulso máximo habitual; verificar con el ESC concreto
#define ESC_ARMING_DELAY_MS 2500UL

#define FAILSAFE_MS 1600UL
#define WATCHDOG_TIMEOUT WDTO_500MS      // reinicia si loop() no vuelve en ~0,5 s
#define USE_WIRE_TIMEOUT 1               // Wire.setWireTimeout: requiere núcleo AVR >= 1.8.3 (poner 0 si no compila)
#define WIRE_TIMEOUT_US 25000UL
#define REQUIRE_LINE_CHECKSUM 1          // 1: las líneas sin "*HH" válido se descartan
#define COMMAND_BUFFER_SIZE 32
#define SIMPLE_PREFIX_TIMEOUT_MS 40UL
#define DEBUG_REPORT_INTERVAL_MS 250UL
#define TELEMETRY_REPORT_INTERVAL_MS 250UL  // Paquete combinado: máximo 4 informes/s
#define TELEMETRY_HEARTBEAT_INTERVAL_MS 1000UL
#define SPEED_UPDATE_INTERVAL_US 20000UL  // Acelerómetro/actitud a 50 Hz
#define SPEED_ACCEL_DEADBAND_MPS2 0.12f
#define SPEED_FILTER_ALPHA 0.25f
#define SPEED_COAST_DECEL_MPS2 0.12f
#define SPEED_MAX_ESTIMATE_MPS 5.0f
#define ATTITUDE_FILTER_ALPHA 0.25f
#ifndef RAD_TO_DEG
  #define RAD_TO_DEG 57.2957795f
#endif
#define GYRO_CALIBRATION_SAMPLES 400
#define GYRO_CALIBRATION_DELAY_MS 10  // Pausa entre muestras del promedio de bias

#define DEFAULT_SPEED 20
#define MOTOR_POWER_LIMIT_DEFAULT DEFAULT_SPEED  // tope hasta que la app envíe PMAX
#define MINIMUM_NONZERO_POWER 3
#define STEERING_CENTER 90

#define MPU_GYRO_CONFIG_VALUE 0x08  // FS_SEL=1: +/-500 grados/s (evita saturar en giros bruscos)
#define GYRO_LSB_PER_DPS 65.5f      // FS_SEL=1: 65,5 LSB por grado/s
#define GYRO_UPDATE_INTERVAL_US 5000UL  // Control yaw nominalmente a 200 Hz
#define PID_OUTPUT_LIMIT_DEG 35.0f
#define PID_DEFAULT_KP 2.0f
#define PID_DEFAULT_KI 0.0f
#define PID_DEFAULT_KD 0.4f

// Registros del MPU-6500.
#define MPU_REG_ACCEL_XOUT_H 0x3B
#define MPU_REG_ACCEL_CONFIG 0x1C
#define MPU_REG_SMPLRT_DIV 0x19
#define MPU_SAMPLE_DIVIDER 0x04       // DLPF activo: 1 kHz / (1 + 4) = 200 Hz
#define MPU_REG_CONFIG 0x1A
#define MPU_REG_GYRO_CONFIG 0x1B
#define MPU_REG_PWR_MGMT_1 0x6B
#define MPU_REG_GYRO_ZOUT_H 0x47
#define MPU_REG_WHO_AM_I 0x75
#define MPU_ACCEL_LSB_PER_G 16384.0f  // ACCEL_CONFIG=0: rango +/-2 g
#define MPU_GRAVITY_MPS2 9.80665f
#define MPU_FORWARD_ACCEL_AXIS 0      // 0 = X, 1 = Y; ajustar a la orientación del módulo
#define MPU_FORWARD_ACCEL_SIGN 1      // Cambiar a -1 si el eje elegido da signo opuesto
// Signos de la convención de telemetría (ver cabecera). Valor 1 = comportamiento
// original; cambiar a -1 solo tras la prueba de banco del README.
#define MPU_YAW_SIGN 1
#define MPU_PITCH_SIGN 1
#define MPU_ROLL_SIGN 1
#if MPU_FORWARD_ACCEL_AXIS != 0 && MPU_FORWARD_ACCEL_AXIS != 1
  #error "MPU_FORWARD_ACCEL_AXIS debe ser 0 (X) o 1 (Y)"
#endif
#define SIMPLE_LEGACY_STEERING_PORT 120
#define SIMPLE_LEGACY_STEERING_STARBOARD 60

// -----------------------------------------------------------------------------
// PWM por hardware con Timer1 (Arduino Uno / ATmega328P a 16 MHz)
// -----------------------------------------------------------------------------
// D9 = OC1A (ESC), D10 = OC1B (servo). Timer1 genera pulsos de 50 Hz por
// hardware; no necesita la ISR periódica de la biblioteca Servo. Esto reduce
// la dependencia de la anchura del pulso respecto al tiempo consumido por I2C.
// Timer1 queda reservado a estas salidas. No usar Servo ni analogWrite en D9/D10.
#define PWM_FRAME_US 20000UL
#define PWM_TIMER1_PRESCALER 8UL
#define PWM_TICKS_PER_US ((F_CPU / PWM_TIMER1_PRESCALER) / 1000000UL)
#define PWM_TOP_TICKS ((PWM_FRAME_US * PWM_TICKS_PER_US) - 1UL)  // 39999
#define SERVO_MIN_PULSE_US 544
#define SERVO_MAX_PULSE_US 2400

#if !defined(__AVR_ATmega328P__) || F_CPU != 16000000L
#error "El PWM Timer1 de este sketch requiere Arduino Uno/ATmega328P a 16 MHz."
#endif

/**
 * Tras un reinicio por watchdog, el AVR conserva el WDT activo con el timeout mínimo;
 * se desactiva en .init3 (antes de main) para evitar reinicios en bucle. setup() lo
 * vuelve a activar cuando termina el armado y la calibración.
 */
void apagarWatchdogAlArrancar(void) __attribute__((naked, used, section(".init3")));
void apagarWatchdogAlArrancar(void) {
  MCUSR = 0;
  wdt_disable();
}

void descartarComandosDeArranque();

/** Convierte una anchura de pulso en microsegundos al compare de Timer1. */
static inline uint16_t pulsoUsACompare(uint16_t pulsoUs) {
  return (uint16_t)(((uint32_t)pulsoUs * PWM_TICKS_PER_US) - 1UL);
}

/** Configura D9/D10 como salidas PWM de 50 Hz sin interrupciones periódicas. */
void iniciarPWMHardware() {
  pinMode(PIN_ESC, OUTPUT);
  pinMode(PIN_SERVO_DIRECCION, OUTPUT);

  // Detener Timer1 antes de configurar Fast PWM, modo 14, TOP = ICR1.
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  ICR1 = (uint16_t)PWM_TOP_TICKS;
  OCR1A = pulsoUsACompare(ESC_STOP_US);

  const uint16_t pulsoCentroUs = (uint16_t)map(
      STEERING_CENTER, 0, 180, SERVO_MIN_PULSE_US, SERVO_MAX_PULSE_US);
  OCR1B = pulsoUsACompare(pulsoCentroUs);

  // Borrar flags pendientes antes de iniciar el contador.
  TIFR1 = _BV(ICF1) | _BV(OCF1A) | _BV(OCF1B) | _BV(TOV1);

  // Salidas no inversoras OC1A/OC1B; Fast PWM modo 14; reloj /8.
  TCCR1A = _BV(COM1A1) | _BV(COM1B1) | _BV(WGM11);
  TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS11);
}

/** Actualiza el pulso del ESC; Timer1 genera el flanco independientemente del loop. */
void escribirPulsoESC(uint16_t pulsoUs) {
  if (pulsoUs < ESC_STOP_US) pulsoUs = ESC_STOP_US;
  if (pulsoUs > ESC_MAX_US) pulsoUs = ESC_MAX_US;
  OCR1A = pulsoUsACompare(pulsoUs);
}

/** Conserva la escala de Servo.write(): 0..180 se traduce a 544..2400 us. */
void escribirAnguloServo(int angulo) {
  angulo = constrain(angulo, 0, 180);
  const uint16_t pulsoUs = (uint16_t)map(
      angulo, 0, 180, SERVO_MIN_PULSE_US, SERVO_MAX_PULSE_US);
  OCR1B = pulsoUsACompare(pulsoUs);
}

// -----------------------------------------------------------------------------
// Objetos y estado global
// -----------------------------------------------------------------------------
NeoSWSerial BT(PIN_BT_RX, PIN_BT_TX);

char linea[COMMAND_BUFFER_SIZE];
uint8_t longitudLinea = 0;
bool descartarLineaLarga = false;
// H y C pueden ser órdenes simples de un byte o el inicio de HOLD/CAL/CRU.
char comandoCortoPendiente = '\0';
uint32_t inicioComandoCortoPendienteMs = 0;

uint32_t ultimaOrdenValidaMs = 0;
uint32_t ultimoControlPidUs = 0;
#if DEBUG
uint32_t ultimoReporteYawMs = 0;
#endif

bool controlActivo = false;
bool mpuDisponible = false;
bool pidActivo = false;
bool cruceroActivo = false;
bool cruceroManualActivo = false;  // true mientras el usuario mueve el timón con crucero encendido
bool telemetriaCombinadaActiva = false;

int potenciaActual = 0;
int direccionManual = STEERING_CENTER;
int direccionAplicada = STEERING_CENTER;

// Calibración del servo: valores por defecto hasta que la app envíe ANG.
int servoCentro = STEERING_CENTER;
int servoBabor = SIMPLE_LEGACY_STEERING_PORT;
int servoEstribor = SIMPLE_LEGACY_STEERING_STARBOARD;
int servoLimiteMin = 0;     // límites mecánicos aplicados al PID (min/max de ANG)
int servoLimiteMax = 180;
int motorPotenciaMax = MOTOR_POWER_LIMIT_DEFAULT;  // tope; la app lo fija con PMAX

float pidP = PID_DEFAULT_KP;
float pidI = PID_DEFAULT_KI;
float pidD = PID_DEFAULT_KD;

float gyroZBias = 0.0f;
float aceleracionAvanceBiasRaw = 0.0f;
float velocidadEstimadaMps = 0.0f;
float aceleracionAvanceFiltradaMps2 = 0.0f;
float pitchBiasGrados = 0.0f;
float rollBiasGrados = 0.0f;
float pitchEstimadoGrados = 0.0f;
float rollEstimadoGrados = 0.0f;
bool actitudInicializada = false;
uint32_t ultimaActualizacionVelocidadUs = 0;
uint32_t ultimoReporteTelemetriaMs = 0;
int16_t ultimoYawTelemetria = 32767;
int16_t ultimoPitchTelemetria = 32767;
int16_t ultimoRollTelemetria = 32767;
int16_t ultimaVelocidadTelemetriaDecimas = 32767;
bool primerPaqueteTelemetriaPendiente = true;
float yawRelativo = 0.0f;
float rumboObjetivo = 0.0f;
float integralError = 0.0f;
float errorAnterior = 0.0f;

// -----------------------------------------------------------------------------
// I2C / MPU6500
// -----------------------------------------------------------------------------

/** Escribe un byte en un registro I2C. */
bool escribirRegistro(uint8_t registro, uint8_t valor) {
  Wire.beginTransmission(MPU_I2C_ADDRESS);
  Wire.write(registro);
  Wire.write(valor);
  return Wire.endTransmission() == 0;
}

/** Lee una secuencia de registros y valida que todos los bytes lleguen por I2C. */
bool leerRegistros(uint8_t registro, uint8_t *buffer, uint8_t cantidad) {
  if (buffer == NULL || cantidad == 0) {
    return false;
  }

  Wire.beginTransmission(MPU_I2C_ADDRESS);
  Wire.write(registro);

  // Repeated START para seleccionar el registro sin liberar el bus I2C.
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  const uint8_t recibidos = Wire.requestFrom(
      (uint8_t)MPU_I2C_ADDRESS,
      (uint8_t)cantidad,
      (uint8_t)true
  );

  if (recibidos != cantidad) {
    while (Wire.available() > 0) {
      Wire.read();
    }
    return false;
  }

  for (uint8_t i = 0; i < cantidad; i++) {
    if (Wire.available() <= 0) {
      while (Wire.available() > 0) {
        Wire.read();
      }
      return false;
    }

    const int dato = Wire.read();
    if (dato < 0) {
      while (Wire.available() > 0) {
        Wire.read();
      }
      return false;
    }

    buffer[i] = (uint8_t)dato;
  }

  return true;
}

/** Inicializa el bus y el gyro. No requiere acelerómetro ni magnetómetro. */
bool iniciarMPU() {
  Wire.begin();
  Wire.setClock(100000);
#if USE_WIRE_TIMEOUT
  // Evita esperar sin límite si SDA/SCL quedan bloqueadas; reinicia el hardware TWI.
  Wire.setWireTimeout(WIRE_TIMEOUT_US, true);
#endif

  uint8_t whoAmI = 0;
  if (!leerRegistros(MPU_REG_WHO_AM_I, &whoAmI, 1)) {
    return false;
  }

  // El WHO_AM_I habitual del MPU6500 es 0x70. Se aceptan variantes compatibles,
  // pero se rechazan valores típicos de bus flotante o dispositivo ausente.
  if (whoAmI == 0x00 || whoAmI == 0xFF) {
    return false;
  }

  if (!escribirRegistro(MPU_REG_PWR_MGMT_1, 0x00)) {
    return false;
  }
  delay(100);

  if (!escribirRegistro(MPU_REG_GYRO_CONFIG, MPU_GYRO_CONFIG_VALUE)) {  // +/-500 grados/s
    return false;
  }
  if (!escribirRegistro(MPU_REG_ACCEL_CONFIG, 0x00)) { // Acelerómetro +/-2 g
    return false;
  }
  if (!escribirRegistro(MPU_REG_CONFIG, 0x03)) {      // Filtro pasa-bajos
    return false;
  }
  if (!escribirRegistro(MPU_REG_SMPLRT_DIV, MPU_SAMPLE_DIVIDER)) {
    return false;
  }

  delay(100);
  return true;
}

/** Lee los tres ejes del acelerómetro en una sola transacción I2C (6 bytes). */
bool leerAcelerometroXYZ(int16_t &ax, int16_t &ay, int16_t &az) {
  uint8_t bytes[6];
  if (!leerRegistros(MPU_REG_ACCEL_XOUT_H, bytes, sizeof(bytes))) {
    return false;
  }

  ax = (int16_t)(((uint16_t)bytes[0] << 8) | bytes[1]);
  ay = (int16_t)(((uint16_t)bytes[2] << 8) | bytes[3]);
  az = (int16_t)(((uint16_t)bytes[4] << 8) | bytes[5]);
  return true;
}

/** Selecciona el eje longitudinal según la orientación de montaje configurada. */
int16_t aceleracionRawAvance(int16_t ax, int16_t ay) {
#if MPU_FORWARD_ACCEL_AXIS == 0
  (void)ay;
  return ax;
#else
  (void)ax;
  return ay;
#endif
}

/**
 * Estima la actitud a partir de la dirección de la gravedad.
 * Supone MPU montado con X longitudinal, Y lateral y Z vertical.
 * Durante aceleraciones/olas los valores pueden desviarse de la inclinación real.
 */
void calcularPitchRollAcelerometro(int16_t ax, int16_t ay, int16_t az,
                                   float &pitchDeg, float &rollDeg) {
  const float x = (float)ax;
  const float y = (float)ay;
  const float z = (float)az;
  pitchDeg = MPU_PITCH_SIGN * atan2f(x, sqrtf(y * y + z * z)) * RAD_TO_DEG;
  rollDeg = MPU_ROLL_SIGN * atan2f(-y, sqrtf(x * x + z * z)) * RAD_TO_DEG;
}

/** Lee la salida signed de 16 bits del eje Z del giroscopio. */
bool leerGyroZ(int16_t &gyroZRaw) {
  uint8_t bytes[2];
  if (!leerRegistros(MPU_REG_GYRO_ZOUT_H, bytes, 2)) {
    return false;
  }

  gyroZRaw = (int16_t)(((uint16_t)bytes[0] << 8) | bytes[1]);

  return true;
}

/** Calibra el bias del gyro Z; el barco debe permanecer inmóvil. */
void calibrarGyro() {
  if (!mpuDisponible) {
    return;
  }

  wdt_reset();
  delay(250);
  int32_t sumaGyro = 0;
  int32_t sumaAceleracion = 0;
  float sumaPitch = 0.0f;
  float sumaRoll = 0.0f;
  uint16_t lecturasGyroValidas = 0;
  uint16_t lecturasAceleracionValidas = 0;

  for (uint16_t i = 0; i < GYRO_CALIBRATION_SAMPLES; i++) {
    wdt_reset();  // la calibración bloquea ~4,5 s; el watchdog sigue vigilando I2C
    int16_t gyroRaw;
    if (leerGyroZ(gyroRaw)) {
      sumaGyro += gyroRaw;
      lecturasGyroValidas++;
    }

    int16_t ax, ay, az;
    if (leerAcelerometroXYZ(ax, ay, az)) {
      sumaAceleracion += aceleracionRawAvance(ax, ay);
      float pitchRawDeg, rollRawDeg;
      calcularPitchRollAcelerometro(ax, ay, az, pitchRawDeg, rollRawDeg);
      sumaPitch += pitchRawDeg;
      sumaRoll += rollRawDeg;
      lecturasAceleracionValidas++;
    }
    delay(GYRO_CALIBRATION_DELAY_MS);
  }

  if (lecturasGyroValidas > 0) {
    gyroZBias = (float)sumaGyro / (float)lecturasGyroValidas;
  }
  if (lecturasAceleracionValidas > 0) {
    // Calibra aceleración y fija la actitud de reposo como cero visual inicial.
    aceleracionAvanceBiasRaw = (float)sumaAceleracion / (float)lecturasAceleracionValidas;
    pitchBiasGrados = sumaPitch / (float)lecturasAceleracionValidas;
    rollBiasGrados = sumaRoll / (float)lecturasAceleracionValidas;
  }

  velocidadEstimadaMps = 0.0f;
  aceleracionAvanceFiltradaMps2 = 0.0f;
  pitchEstimadoGrados = 0.0f;
  rollEstimadoGrados = 0.0f;
  actitudInicializada = false;
  ultimaActualizacionVelocidadUs = micros();
  yawRelativo = 0.0f;
  rumboObjetivo = 0.0f;
  integralError = 0.0f;
  errorAnterior = 0.0f;
  ultimoControlPidUs = micros();
}

// -----------------------------------------------------------------------------
// ESC y servo de dirección
// -----------------------------------------------------------------------------

/** Escribe el pulso de parada explícitamente, incluso si el estado ya dice 0. */
void detenerMotorSeguro() {
  escribirPulsoESC(ESC_STOP_US);
  potenciaActual = 0;
#if DEBUG
  Serial.print(F("MOTOR_STOP,pulse_us="));
  Serial.println(ESC_STOP_US);
#endif
}

/** Convierte potencia de protocolo 0..180 a un pulso ESC en microsegundos. */
uint16_t potenciaAPulsoESC(int potencia) {
  if (potencia <= 0) {
    return ESC_STOP_US;
  }

  potencia = constrain(potencia, MINIMUM_NONZERO_POWER, 180);
  return (uint16_t)map(
      potencia,
      MINIMUM_NONZERO_POWER,
      180,
      ESC_MIN_ACTIVE_US,
      ESC_MAX_US);
}

/** Aplica potencia. Cero siempre envía el pulso mínimo de parada. */
void aplicarMotor(int potencia) {
  potencia = constrain(potencia, 0, 180);
  if (potencia > 0) {
    potencia = max(potencia, MINIMUM_NONZERO_POWER);
  }
  // Tope en el firmware: una orden corrupta o excesiva nunca supera el máximo de la app.
  if (potencia > motorPotenciaMax) {
    potencia = motorPotenciaMax;
  }

  if (potencia == 0) {
    detenerMotorSeguro();
    return;
  }
  if (potencia != potenciaActual) {
    const uint16_t pulsoUs = potenciaAPulsoESC(potencia);
    escribirPulsoESC(pulsoUs);
    potenciaActual = potencia;

#if DEBUG
    Serial.print(F("MOTOR_CMD,power="));
    Serial.print(potencia);
    Serial.print(F(",pulse_us="));
    Serial.println(pulsoUs);
#endif
  }
}

/** Cambia únicamente el servo de dirección. */
void aplicarServo(int angulo) {
  angulo = constrain(angulo, 0, 180);
  if (angulo != direccionAplicada) {
    escribirAnguloServo(angulo);
    direccionAplicada = angulo;
  }
}

void registrarOrdenValida() {
  ultimaOrdenValidaMs = millis();
  controlActivo = true;
}

// -----------------------------------------------------------------------------
// Validación estricta de comandos
// -----------------------------------------------------------------------------

/** Acepta solo dígitos decimales enteros; rechaza sufijos y valores fuera de rango. */
bool parsearEnteroEstricto(const char *texto, int minimo, int maximo, int &resultado) {
  if (texto == NULL || *texto == '\0') {
    return false;
  }

  long valor = 0;
  for (const char *p = texto; *p != '\0'; p++) {
    if (*p < '0' || *p > '9') {
      return false;
    }

    const int digito = *p - '0';
    // Evita overflow de long en ATmega328P antes de comprobar el rango.
    if (digito > maximo || valor > (maximo - digito) / 10L) {
      return false;
    }
    valor = valor * 10L + digito;
  }

  if (valor < minimo) {
    return false;
  }

  resultado = (int)valor;
  return true;
}

/**
 * Acepta decimal con signo opcional y un punto opcional; rechaza exponentes,
 * letras, NaN, infinito y valores fuera del rango indicado.
 */
bool parsearFloatEstricto(const char *texto, float minimo, float maximo, float &resultado) {
  if (texto == NULL || *texto == '\0') {
    return false;
  }

  const char *p = texto;
  if (*p == '+' || *p == '-') {
    p++;
  }

  bool hayDigito = false;
  bool hayPunto = false;
  for (; *p != '\0'; p++) {
    if (*p >= '0' && *p <= '9') {
      hayDigito = true;
    } else if (*p == '.' && !hayPunto) {
      hayPunto = true;
    } else {
      return false;
    }
  }

  if (!hayDigito) {
    return false;
  }

  const float valor = (float)atof(texto);
  if (!isfinite(valor) || valor < minimo || valor > maximo) {
    return false;
  }

  resultado = valor;
  return true;
}

// -----------------------------------------------------------------------------
// Protocolo Bluetooth
// -----------------------------------------------------------------------------

/** Valor 0..15 de un dígito hexadecimal, o -1 si no lo es. */
int valorHex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

/**
 * Valida "<orden>*<HH>" (HH = XOR de los bytes de <orden>). Si es correcto, recorta
 * el sufijo y devuelve true. Sin sufijo solo se acepta con REQUIRE_LINE_CHECKSUM 0.
 */
bool validarChecksumLinea(char *texto) {
  char *asterisco = strrchr(texto, '*');
  if (asterisco == NULL) {
    return REQUIRE_LINE_CHECKSUM == 0;
  }
  if (strlen(asterisco) != 3) {
    return false;
  }
  const int alto = valorHex(asterisco[1]);
  const int bajo = valorHex(asterisco[2]);
  if (alto < 0 || bajo < 0) {
    return false;
  }
  uint8_t xorBytes = 0;
  for (const char *p = texto; p < asterisco; p++) {
    xorBytes ^= (uint8_t)*p;
  }
  if (xorBytes != (uint8_t)((alto << 4) | bajo)) {
    return false;
  }
  *asterisco = '\0';
  return true;
}

/** Aplica la calibración del servo de la app y reposiciona el timón si procede. */
void aplicarCalibracionServo(int centro, int babor, int estribor) {
  const int centroAnterior = servoCentro;
  servoCentro = centro;
  servoBabor = babor;
  servoEstribor = estribor;
  servoLimiteMin = min(min(babor, estribor), centro);
  servoLimiteMax = max(max(babor, estribor), centro);
  if (direccionManual == centroAnterior) {
    direccionManual = centro;
  }
  // Si el PID gobierna el timón, él lo reposiciona en su próximo ciclo.
  if (!(cruceroActivo && !cruceroManualActivo)) {
    aplicarServo(direccionManual);
  }
}

void manejarComando(char *comando) {
  if (comando == NULL || comando[0] == '\0') {
    return;
  }

  int valorEntero = 0;
  float valorFloat = 0.0f;

  // P<n> controla exclusivamente el motor.
  if (comando[0] == 'P' && comando[1] >= '0' && comando[1] <= '9') {
    if (parsearEnteroEstricto(comando + 1, 0, 180, valorEntero)) {
      aplicarMotor(valorEntero);
      registrarOrdenValida();
    }
    return;
  }

  // D<n> controla el timón. En crucero activa una anulación manual temporal;
  // el PID vuelve a tomar el control cuando llega HOLD al soltar el slider.
  if (comando[0] == 'D' && comando[1] >= '0' && comando[1] <= '9') {
    if (parsearEnteroEstricto(comando + 1, 0, 180, valorEntero)) {
      direccionManual = valorEntero;
      if (cruceroActivo) cruceroManualActivo = true;
      aplicarServo(direccionManual);
      registrarOrdenValida();
    }
    return;
  }

  if (strcmp(comando, "F") == 0) {
    // Semántica del firmware Simple anterior: F centra el timón y aplica potencia fija.
    direccionManual = servoCentro;
    if (cruceroActivo) cruceroManualActivo = true;
    aplicarServo(servoCentro);
    aplicarMotor(DEFAULT_SPEED);
    registrarOrdenValida();
    return;
  }

  if (strcmp(comando, "S") == 0) {
    detenerMotorSeguro();
    registrarOrdenValida();
    return;
  }

  if (strcmp(comando, "L") == 0 || strcmp(comando, "G") == 0) {
    // En el protocolo Simple antiguo, L/R también activaban el motor a potencia fija.
    direccionManual = servoBabor;
    if (cruceroActivo) cruceroManualActivo = true;
    aplicarServo(direccionManual);
    aplicarMotor(DEFAULT_SPEED);
    registrarOrdenValida();
    return;
  }

  if (strcmp(comando, "C") == 0) {
    direccionManual = servoCentro;
    if (cruceroActivo) cruceroManualActivo = true;
    aplicarServo(direccionManual);
    registrarOrdenValida();
    return;
  }

  if (strcmp(comando, "R") == 0 || strcmp(comando, "H") == 0) {
    direccionManual = servoEstribor;
    if (cruceroActivo) cruceroManualActivo = true;
    aplicarServo(direccionManual);
    aplicarMotor(DEFAULT_SPEED);
    registrarOrdenValida();
    return;
  }

  // La app manda HOLD una sola vez al soltar el timón en modo crucero.
  // Se captura el yaw ya alcanzado y el PID vuelve a mantener esa nueva dirección.
  if (strcmp(comando, "HOLD") == 0) {
    if (pidActivo && cruceroActivo && mpuDisponible) {
      rumboObjetivo = yawRelativo;
      cruceroManualActivo = false;
      integralError = 0.0f;
      errorAnterior = 0.0f;
      direccionManual = servoCentro;
      aplicarServo(servoCentro);
      registrarOrdenValida();
    }
    return;
  }

  // ANG,centro,babor,estribor: calibración del servo definida en la app.
  // No renueva el failsafe de los comandos de control.
  if (strncmp(comando, "ANG,", 4) == 0) {
    char *campoCentro = comando + 4;
    char *coma1 = strchr(campoCentro, ',');
    if (coma1 == NULL) return;
    *coma1 = '\0';
    char *campoBabor = coma1 + 1;
    char *coma2 = strchr(campoBabor, ',');
    if (coma2 == NULL) return;
    *coma2 = '\0';
    char *campoEstribor = coma2 + 1;
    int centro, babor, estribor;
    if (!parsearEnteroEstricto(campoCentro, 0, 180, centro) ||
        !parsearEnteroEstricto(campoBabor, 0, 180, babor) ||
        !parsearEnteroEstricto(campoEstribor, 0, 180, estribor)) {
      return;
    }
    aplicarCalibracionServo(centro, babor, estribor);
    return;
  }

  // PMAX,n: tope de potencia del motor. No renueva el failsafe.
  if (strncmp(comando, "PMAX,", 5) == 0) {
    if (parsearEnteroEstricto(comando + 5, 1, 180, valorEntero)) {
      motorPotenciaMax = valorEntero;
      if (potenciaActual > motorPotenciaMax) {
        aplicarMotor(motorPotenciaMax);
      }
    }
    return;
  }

  // Telemetría combinada: un solo paquete mantiene sincronizados todos los instrumentos.
  // Formato: T,yaw,pitch,roll,velocidad_en_decimas_de_m_s\n.
  // No renueva el failsafe de los comandos de control.
  if (strncmp(comando, "TEL,", 4) == 0) {
    if (!parsearEnteroEstricto(comando + 4, 0, 1, valorEntero)) return;
    telemetriaCombinadaActiva = (valorEntero == 1);
    if (telemetriaCombinadaActiva) {
      primerPaqueteTelemetriaPendiente = true;
      ultimoReporteTelemetriaMs = 0;
      ultimoYawTelemetria = 32767;
      ultimoPitchTelemetria = 32767;
      ultimoRollTelemetria = 32767;
      ultimaVelocidadTelemetriaDecimas = 32767;
    }
    return;
  }

  if (strncmp(comando, "PID,", 4) == 0) {
    if (!parsearEnteroEstricto(comando + 4, 0, 1, valorEntero)) {
      return;
    }

    pidActivo = (valorEntero == 1) && mpuDisponible;
    if (!pidActivo) {
      cruceroActivo = false;
      cruceroManualActivo = false;
      aplicarServo(direccionManual);
    }
    integralError = 0.0f;
    errorAnterior = 0.0f;
    registrarOrdenValida();
    return;
  }

  if (strncmp(comando, "CRU,", 4) == 0) {
    if (!parsearEnteroEstricto(comando + 4, 0, 1, valorEntero)) {
      return;
    }

    cruceroActivo = (valorEntero == 1) && pidActivo && mpuDisponible;
    cruceroManualActivo = false;
    if (cruceroActivo) {
      rumboObjetivo = yawRelativo;
      integralError = 0.0f;
      errorAnterior = 0.0f;
    } else {
      aplicarServo(direccionManual);
    }
    registrarOrdenValida();
    return;
  }

  if (strncmp(comando, "KP,", 3) == 0) {
    if (parsearFloatEstricto(comando + 3, 0.0f, 50.0f, valorFloat)) {
      pidP = valorFloat;
      registrarOrdenValida();
    }
    return;
  }

  if (strncmp(comando, "KI,", 3) == 0) {
    if (parsearFloatEstricto(comando + 3, 0.0f, 10.0f, valorFloat)) {
      pidI = valorFloat;
      registrarOrdenValida();
    }
    return;
  }

  if (strncmp(comando, "KD,", 3) == 0) {
    if (parsearFloatEstricto(comando + 3, 0.0f, 50.0f, valorFloat)) {
      pidD = valorFloat;
      registrarOrdenValida();
    }
    return;
  }

  if (strcmp(comando, "CAL") == 0) {
    // Evita que el motor siga accionado durante la calibración, que bloquea el loop.
    detenerMotorSeguro();
    cruceroActivo = false;
    cruceroManualActivo = false;
    integralError = 0.0f;
    errorAnterior = 0.0f;
    aplicarServo(direccionManual);

#if DEBUG
    if (mpuDisponible) {
      Serial.println(F("CAL: mantenga el barco inmovil..."));
    }
#endif

    calibrarGyro();
    // La calibración bloquea ~4,5 s: lo recibido mientras tanto es obsoleto y no debe ejecutarse.
    descartarComandosDeArranque();

#if DEBUG
    if (mpuDisponible) {
      Serial.print(F("CAL_OK,biasZ="));
      Serial.println(gyroZBias, 2);
    }
#endif

    registrarOrdenValida();
    return;
  }

  // Las órdenes desconocidas o incompletas se ignoran y no reinician el failsafe.
}

/** Ejecuta H/C pendientes, sin confundirlos con HOLD/CAL/CRU. */
void ejecutarComandoCortoPendiente() {
  if (comandoCortoPendiente == '\0') return;
  char comando[2] = {comandoCortoPendiente, '\0'};
  comandoCortoPendiente = '\0';
  manejarComando(comando);
}

/**
 * Lee órdenes avanzadas terminadas en LF/CR y bytes simples de Arduino Bluetooth
 * Control. F/S/L/G/R se ejecutan inmediatamente; H/C esperan brevemente porque
 * también pueden iniciar HOLD, CAL o CRU.
 */
void leerBluetooth() {
  while (BT.available() > 0) {
    const char caracter = (char)BT.read();

    if (comandoCortoPendiente != '\0') {
      const bool prefijoLargo =
          (comandoCortoPendiente == 'H' && caracter == 'O') ||
          (comandoCortoPendiente == 'C' && (caracter == 'A' || caracter == 'R'));
      if (prefijoLargo) {
        // H + O => HOLD; C + A/R => CAL/CRU. Continúa acumulando la línea.
        linea[longitudLinea++] = comandoCortoPendiente;
        comandoCortoPendiente = '\0';
      } else {
        ejecutarComandoCortoPendiente();
      }
    }

    if (caracter == '\n' || caracter == '\r') {
      if (!descartarLineaLarga && longitudLinea > 0) {
        linea[longitudLinea] = '\0';
        if (validarChecksumLinea(linea)) {
          manejarComando(linea);
        }
      }
      longitudLinea = 0;
      descartarLineaLarga = false;
      continue;
    }

    if (descartarLineaLarga) continue;

    if (longitudLinea == 0) {
      if (caracter == 'F' || caracter == 'S' || caracter == 'L' ||
          caracter == 'G' || caracter == 'R') {
        char comando[2] = {caracter, '\0'};
        manejarComando(comando);
        continue;
      }
      if (caracter == 'H' || caracter == 'C') {
        comandoCortoPendiente = caracter;
        inicioComandoCortoPendienteMs = millis();
        continue;
      }
    }

    if (longitudLinea < sizeof(linea) - 1) {
      linea[longitudLinea++] = caracter;
    } else {
      longitudLinea = 0;
      descartarLineaLarga = true;
    }
  }

  // Un H/C aislado sin salto de línea corresponde al controlador clásico.
  if (comandoCortoPendiente != '\0' &&
      (uint32_t)(millis() - inicioComandoCortoPendienteMs) >= SIMPLE_PREFIX_TIMEOUT_MS) {
    ejecutarComandoCortoPendiente();
  }
}

// -----------------------------------------------------------------------------
// Yaw relativo y PID de rumbo
// -----------------------------------------------------------------------------

/** Actualiza la integral del yaw y, si está habilitado, aplica la corrección PID. */
void actualizarYawYControl() {
  if (!mpuDisponible) {
    return;
  }

  const uint32_t ahoraUs = micros();
  if (ultimoControlPidUs == 0) {
    ultimoControlPidUs = ahoraUs;
    return;
  }

  const uint32_t transcurridoUs = ahoraUs - ultimoControlPidUs;

  // El MPU esta configurado aproximadamente a 200 Hz (SMPLRT_DIV=4 con DLPF activo).
  // Programa el control a intervalos nominales de 5 ms, alineados con 200 Hz.
  // Evita releer la misma muestra muchas veces en una vuelta rapida de loop().
  if (transcurridoUs < GYRO_UPDATE_INTERVAL_US) {
    return;
  }

  ultimoControlPidUs = ahoraUs;
  const float dt = transcurridoUs / 1000000.0f;

  // Descarta deltas anómalos (por ejemplo, tras una operación bloqueante).
  if (dt <= 0.0f || dt > 0.15f) {
    return;
  }

  int16_t gyroZRaw;
  if (!leerGyroZ(gyroZRaw)) {
    return;
  }

  const float tasaGradosSegundo = ((float)gyroZRaw - gyroZBias) / GYRO_LSB_PER_DPS;
  yawRelativo += MPU_YAW_SIGN * tasaGradosSegundo * dt;

  if (!pidActivo || !cruceroActivo || cruceroManualActivo) {
    return;
  }

  float error = rumboObjetivo - yawRelativo;
  while (error > 180.0f) error -= 360.0f;
  while (error < -180.0f) error += 360.0f;

  integralError = constrain(integralError + error * dt, -60.0f, 60.0f);
  const float derivada = (error - errorAnterior) / dt;
  errorAnterior = error;

  float salida = pidP * error + pidI * integralError + pidD * derivada;
  salida = constrain(salida, -PID_OUTPUT_LIMIT_DEG, PID_OUTPUT_LIMIT_DEG);

  // salida > 0 = hay que girar a estribor (yaw positivo). El sentido del servo sale de
  // la calibración de la app: si "estribor" tiene un ángulo mayor que el centro el
  // servo sube, y si no (por defecto 60 < 90) baja. Así no depende de un signo fijo.
  const int sentidoEstribor = (servoEstribor > servoCentro) ? 1 : -1;
  int servo = servoCentro + sentidoEstribor * (int)lroundf(salida);
  servo = constrain(servo,
                    servoCentro - (int)PID_OUTPUT_LIMIT_DEG,
                    servoCentro + (int)PID_OUTPUT_LIMIT_DEG);
  servo = constrain(servo, servoLimiteMin, servoLimiteMax);
  aplicarServo(servo);
}

/** Detiene el motor cuando no llegan comandos; el crucero puede seguir corrigiendo. */
void aplicarFailsafe() {
  detenerMotorSeguro();

  if (cruceroActivo) {
    // Si la conexión cae mientras el usuario gira manualmente, captura el yaw
    // actual, recentra el timón y deja que el PID mantenga esa dirección.
    if (cruceroManualActivo) {
      rumboObjetivo = yawRelativo;
      cruceroManualActivo = false;
      integralError = 0.0f;
      errorAnterior = 0.0f;
      direccionManual = servoCentro;
      aplicarServo(servoCentro);
    }
  } else {
    cruceroManualActivo = false;
    direccionManual = servoCentro;
    aplicarServo(servoCentro);
  }

  controlActivo = false;
}

float yawParaMonitor(float yaw) {
  while (yaw >= 180.0f) yaw -= 360.0f;
  while (yaw < -180.0f) yaw += 360.0f;
  return yaw;
}

/**
 * Estima velocidad longitudinal integrando aceleración de un eje del MPU.
 * Deriva con el tiempo: es una indicación aproximada, no velocidad real calibrada.
 */
void actualizarVelocidadEstimada() {
  if (!mpuDisponible) return;

  const uint32_t ahoraUs = micros();
  if (ultimaActualizacionVelocidadUs == 0) {
    ultimaActualizacionVelocidadUs = ahoraUs;
    return;
  }
  const uint32_t deltaUs = ahoraUs - ultimaActualizacionVelocidadUs;
  if (deltaUs < SPEED_UPDATE_INTERVAL_US) return;
  ultimaActualizacionVelocidadUs = ahoraUs;

  const float dt = deltaUs / 1000000.0f;
  if (dt <= 0.0f || dt > 0.10f) {
    aceleracionAvanceFiltradaMps2 = 0.0f;
    return;
  }

  int16_t ax, ay, az;
  if (!leerAcelerometroXYZ(ax, ay, az)) return;

  // Actualiza actitud real estimada con el acelerómetro a 50 Hz aprox.
  float pitchRawDeg, rollRawDeg;
  calcularPitchRollAcelerometro(ax, ay, az, pitchRawDeg, rollRawDeg);
  const float pitchObjetivo = constrain(pitchRawDeg - pitchBiasGrados, -90.0f, 90.0f);
  const float rollObjetivo = constrain(rollRawDeg - rollBiasGrados, -180.0f, 180.0f);
  if (!actitudInicializada) {
    pitchEstimadoGrados = pitchObjetivo;
    rollEstimadoGrados = rollObjetivo;
    actitudInicializada = true;
  } else {
    pitchEstimadoGrados += ATTITUDE_FILTER_ALPHA * (pitchObjetivo - pitchEstimadoGrados);
    rollEstimadoGrados += ATTITUDE_FILTER_ALPHA * (rollObjetivo - rollEstimadoGrados);
  }

  const int16_t aceleracionRaw = aceleracionRawAvance(ax, ay);
  float aceleracionMps2 = ((float)aceleracionRaw - aceleracionAvanceBiasRaw) /
      MPU_ACCEL_LSB_PER_G * MPU_GRAVITY_MPS2 * MPU_FORWARD_ACCEL_SIGN;
  if (fabsf(aceleracionMps2) < SPEED_ACCEL_DEADBAND_MPS2) aceleracionMps2 = 0.0f;

  aceleracionAvanceFiltradaMps2 += SPEED_FILTER_ALPHA *
      (aceleracionMps2 - aceleracionAvanceFiltradaMps2);

  if (potenciaActual == 0 && fabsf(aceleracionAvanceFiltradaMps2) < SPEED_ACCEL_DEADBAND_MPS2) {
    // Decaimiento heurístico para no conservar una velocidad ficticia indefinidamente.
    velocidadEstimadaMps -= SPEED_COAST_DECEL_MPS2 * dt;
  } else {
    velocidadEstimadaMps += aceleracionAvanceFiltradaMps2 * dt;
  }

  if (!isfinite(velocidadEstimadaMps) || velocidadEstimadaMps < 0.0f) velocidadEstimadaMps = 0.0f;
  if (velocidadEstimadaMps > SPEED_MAX_ESTIMATE_MPS) velocidadEstimadaMps = SPEED_MAX_ESTIMATE_MPS;
}

/**
 * Telemetría combinada compacta: T,yaw,pitch,roll,velocidad_decimas\n.
 * Ejemplo T,-12,4,-7,12 significa yaw -12°, pitch +4°, roll -7°, velocidad 1.2 m/s.
 * Máximo 4 paquetes/s cuando hay cambios; si todo permanece quieto, latido cada segundo.
 */
void reportarTelemetriaBluetooth() {
  if (!telemetriaCombinadaActiva || !mpuDisponible) return;

  const uint32_t ahoraMs = millis();
  const int16_t yaw = (int16_t)lroundf(yawParaMonitor(yawRelativo));
  const int16_t pitch = (int16_t)constrain(lroundf(pitchEstimadoGrados), -90L, 90L);
  const int16_t roll = (int16_t)constrain(lroundf(rollEstimadoGrados), -180L, 180L);
  int16_t velocidadDecimas = (int16_t)lroundf(velocidadEstimadaMps * 10.0f);
  velocidadDecimas = constrain(velocidadDecimas, 0, (int16_t)lroundf(SPEED_MAX_ESTIMATE_MPS * 10.0f));

  const bool cambio = yaw != ultimoYawTelemetria ||
      pitch != ultimoPitchTelemetria || roll != ultimoRollTelemetria ||
      velocidadDecimas != ultimaVelocidadTelemetriaDecimas;
  const bool latidoVencido = !primerPaqueteTelemetriaPendiente &&
      (uint32_t)(ahoraMs - ultimoReporteTelemetriaMs) >= TELEMETRY_HEARTBEAT_INTERVAL_MS;

  if (!primerPaqueteTelemetriaPendiente &&
      (uint32_t)(ahoraMs - ultimoReporteTelemetriaMs) < TELEMETRY_REPORT_INTERVAL_MS) return;
  if (!primerPaqueteTelemetriaPendiente && !cambio && !latidoVencido) return;

  BT.print(F("T,"));
  BT.print(yaw);
  BT.print(',');
  BT.print(pitch);
  BT.print(',');
  BT.print(roll);
  BT.print(',');
  BT.println(velocidadDecimas);

  ultimoYawTelemetria = yaw;
  ultimoPitchTelemetria = pitch;
  ultimoRollTelemetria = roll;
  ultimaVelocidadTelemetriaDecimas = velocidadDecimas;
  ultimoReporteTelemetriaMs = ahoraMs;
  primerPaqueteTelemetriaPendiente = false;
}

/** Descarta bytes acumulados mientras el firmware armaba el ESC/calibraba el gyro. */
void descartarComandosDeArranque() {
#if DEBUG
  bool habiaDatos = false;
#endif
  while (BT.available() > 0) {
    BT.read();
#if DEBUG
    habiaDatos = true;
#endif
  }
  longitudLinea = 0;
  descartarLineaLarga = false;
  comandoCortoPendiente = '\0';
#if DEBUG
  if (habiaDatos) {
    Serial.println(F("BT_STARTUP_QUEUE_DISCARDED"));
  }
#endif
}

#if DEBUG
/** Emite solo por USB Serial; no manda telemetría al HC-06. */
void reportarYawUSB() {
  const uint32_t ahoraMs = millis();
  if ((uint32_t)(ahoraMs - ultimoReporteYawMs) < DEBUG_REPORT_INTERVAL_MS) {
    return;
  }
  ultimoReporteYawMs = ahoraMs;

  if (!mpuDisponible) {
    Serial.println(F("MPU6500=NO_DETECTADO; YAW=NO_DISPONIBLE"));
    return;
  }

  Serial.print(F("YAW_RELATIVO_DEG="));
  Serial.print(yawParaMonitor(yawRelativo), 2);
  Serial.print(F(",PID="));
  Serial.print(pidActivo ? F("ON") : F("OFF"));
  Serial.print(F(",CRUCERO="));
  Serial.println(cruceroActivo ? F("ON") : F("OFF"));
}
#endif

// -----------------------------------------------------------------------------
// Arduino setup / loop
// -----------------------------------------------------------------------------

void setup() {
#if DEBUG
  Serial.begin(USB_SERIAL_BAUD);
  Serial.println(F("Barco RC - diagnostico MPU6500 200 Hz"));
  Serial.println(F("Monitor serie USB: 9600 baudios"));
#endif

  BT.begin(BT_BAUD);

  // Timer1 genera ESC y servo por hardware desde el arranque.
  iniciarPWMHardware();
  escribirPulsoESC(ESC_STOP_US);
  escribirAnguloServo(STEERING_CENTER);

  potenciaActual = 0;
  direccionAplicada = STEERING_CENTER;
  direccionManual = STEERING_CENTER;
  controlActivo = false;
  delay(ESC_ARMING_DELAY_MS);
  detenerMotorSeguro();

  mpuDisponible = iniciarMPU();
  if (mpuDisponible) {
#if DEBUG
    Serial.println(F("MPU6500=DETECTADO; calibrando gyro Z, mantener barco inmovil"));
#endif
    calibrarGyro();
#if DEBUG
    Serial.print(F("CAL_OK,biasZ="));
    Serial.println(gyroZBias, 2);
#endif
  } else {
#if DEBUG
    Serial.println(F("ERROR: MPU6500 no detectado en I2C 0x68; comprobar SDA=A4, SCL=A5, VCC y GND"));
#endif
  }

  // Evita ejecutar órdenes antiguas almacenadas durante el armado/calibración.
  descartarComandosDeArranque();
  controlActivo = false;
  ultimoControlPidUs = micros();
#if DEBUG
  ultimoReporteYawMs = millis();
#endif

  // A partir de aquí loop() debe volver en menos de WATCHDOG_TIMEOUT; si no, reinicio.
  wdt_enable(WATCHDOG_TIMEOUT);
}

void loop() {
  wdt_reset();
  leerBluetooth();
  actualizarYawYControl();
  actualizarVelocidadEstimada();
  reportarTelemetriaBluetooth();

#if DEBUG
  reportarYawUSB();
#endif

  if (controlActivo && (uint32_t)(millis() - ultimaOrdenValidaMs) > FAILSAFE_MS) {
    aplicarFailsafe();
  }
}
