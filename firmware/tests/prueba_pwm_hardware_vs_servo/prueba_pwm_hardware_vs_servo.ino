/*
  Prueba A/B: pulso del ESC por libreria Servo o por hardware (Timer1)
  ====================================================================
  *** SIEMPRE SIN HELICE ***

  Objetivo: decidir si los tirones los causa la INTERRUPCION de la libreria
  Servo (jitter en el pulso al coincidir con la actividad I2C) o algo
  ELECTRICO (ruido, alimentacion).

  Este sketch hace solo dos cosas:
    1) Mantiene el ESC en 1000 us (reposo) y el servo de direccion al centro.
    2) Lee el gyro Z del MPU6500 por I2C con el mismo patron que el firmware.

  Como se usa (misma placa, mismo cableado, misma bateria):
    - Compila con PWM_BACKEND 0 (libreria Servo)  -> cuenta tirones en 3 min.
    - Compila con PWM_BACKEND 1 (Timer1 hardware) -> cuenta tirones en 3 min.
    - Repite en orden inverso para descartar efecto de bateria/calentamiento.

  Como leer el resultado:
    - Con 0 hay tirones y con 1 NO  -> la causa es el jitter de la interrupcion
      de Servo. Solucion: usar Timer1 por hardware tambien en el firmware.
    - Con 1 siguen igual            -> la causa es electrica. Probar: BEC al
      pin 5V (no a VIN), 10 kohm de D9 a GND, cables del MPU lejos de los del
      motor, filtro RC en la senal del ESC.

  Con el Monitor Serie (9600) puedes cambiar el intervalo de lectura sin
  recompilar:  1 = 5 ms (200 Hz)   2 = 10 ms (100 Hz)   3 = 20 ms (50 Hz)
               0 = sin lecturas I2C (referencia)       p = imprimir resumen
  Cada 10 s imprime un resumen. No uses USB y el cable rojo del BEC a la vez.

  Pines (los del proyecto): D9 = ESC (OC1A), D10 = servo de direccion (OC1B).
  Ambos son salidas de Timer1, por eso el modo hardware funciona en los dos.
*/

#include <Wire.h>

#ifndef PWM_BACKEND
#define PWM_BACKEND 1   // 1 = Timer1 por hardware | 0 = libreria Servo
#endif

#ifndef SMPLRT_DIV_VALOR
#define SMPLRT_DIV_VALOR 0x04   // 0x04 = 200 Hz (la configuracion con tirones)
#endif

#if PWM_BACKEND == 0
#include <Servo.h>
Servo esc;
Servo direccion;
#endif

const uint8_t PIN_ESC = 9;
const uint8_t PIN_DIRECCION = 10;
const uint16_t ESC_REPOSO_US = 1000;
const uint16_t DIRECCION_CENTRO_US = 1500;
const uint32_t ARMADO_MS = 2500UL;       // igual que el firmware
const uint32_t RESUMEN_CADA_MS = 10000UL;

const uint8_t MPU_ADDR = 0x68;
const uint8_t REG_SMPLRT_DIV = 0x19;
const uint8_t REG_CONFIG = 0x1A;
const uint8_t REG_GYRO_CONFIG = 0x1B;
const uint8_t REG_GYRO_ZOUT_H = 0x47;
const uint8_t REG_PWR_MGMT_1 = 0x6B;

uint32_t intervaloUs = 5000UL;   // 0 = sin lecturas
uint32_t ultimaLecturaUs = 0;
uint32_t ultimoResumenMs = 0;
uint32_t lecturasOk = 0;
uint32_t lecturasFallo = 0;
bool mpuListo = false;

// ---- Salida de pulsos ----
#if PWM_BACKEND == 1
// Fast PWM modo 14, TOP = ICR1, prescaler 8: 2 ticks por microsegundo.
// Periodo 20 ms (40000 ticks). En Fast PWM el pulso dura OCR + 1 ticks.
inline uint16_t ticksPulso(uint16_t us) {
  return (uint16_t)(us * 2U - 1U);
}
#endif

void iniciarSalidas() {
#if PWM_BACKEND == 1
  pinMode(PIN_ESC, OUTPUT);
  pinMode(PIN_DIRECCION, OUTPUT);
  TCCR1A = 0;
  TCCR1B = 0;
  ICR1 = 39999;
  OCR1A = ticksPulso(ESC_REPOSO_US);        // D9  = OC1A
  OCR1B = ticksPulso(DIRECCION_CENTRO_US);  // D10 = OC1B
  TCNT1 = 0;
  TCCR1A = _BV(COM1A1) | _BV(COM1B1) | _BV(WGM11);
  TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS11);
#else
  esc.attach(PIN_ESC, 1000, 2000);
  esc.writeMicroseconds(ESC_REPOSO_US);
  direccion.attach(PIN_DIRECCION);
  direccion.write(90);
#endif
}

// ---- MPU6500 (mismo patron de acceso que el firmware) ----
bool escribirRegistro(uint8_t registro, uint8_t valor) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(registro);
  Wire.write(valor);
  return Wire.endTransmission() == 0;
}

bool leerGyroZ(int16_t &raw) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_GYRO_ZOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)2, (uint8_t)true) != 2) return false;
  const uint8_t alto = Wire.read();
  const uint8_t bajo = Wire.read();
  raw = (int16_t)(((uint16_t)alto << 8) | bajo);
  return true;
}

bool iniciarMPU() {
  Wire.begin();
  Wire.setClock(100000);
  return escribirRegistro(REG_PWR_MGMT_1, 0x00) &&
         escribirRegistro(REG_GYRO_CONFIG, 0x00) &&
         escribirRegistro(REG_CONFIG, 0x03) &&
         escribirRegistro(REG_SMPLRT_DIV, SMPLRT_DIV_VALOR);
}

// ---- Informes y comandos ----
void imprimirResumen() {
  Serial.print(F("backend="));
#if PWM_BACKEND == 1
  Serial.print(F("HARDWARE"));
#else
  Serial.print(F("SERVO"));
#endif
  Serial.print(F(" intervalo="));
  Serial.print(intervaloUs);
  Serial.print(F("us lecturas="));
  Serial.print(lecturasOk);
  Serial.print(F(" fallos="));
  Serial.println(lecturasFallo);
}

void leerComandos() {
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    switch (c) {
      case '0': intervaloUs = 0; break;
      case '1': intervaloUs = 5000UL; break;
      case '2': intervaloUs = 10000UL; break;
      case '3': intervaloUs = 20000UL; break;
      case 'p': case 'P': break;
      default: continue;
    }
    imprimirResumen();
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  iniciarSalidas();           // el ESC recibe 1000 us desde el principio
  delay(ARMADO_MS);           // armado, igual que el firmware
  mpuListo = iniciarMPU();
  Serial.println(mpuListo ? F("MPU6500 OK") : F("MPU6500 NO responde (revisa SDA=A4, SCL=A5)"));
  imprimirResumen();
  ultimaLecturaUs = micros();
  ultimoResumenMs = millis();
}

void loop() {
  leerComandos();

  if (mpuListo && intervaloUs > 0) {
    const uint32_t ahoraUs = micros();
    if ((uint32_t)(ahoraUs - ultimaLecturaUs) >= intervaloUs) {
      ultimaLecturaUs = ahoraUs;
      int16_t raw;
      if (leerGyroZ(raw)) lecturasOk++; else lecturasFallo++;
    }
  }

  if ((uint32_t)(millis() - ultimoResumenMs) >= RESUMEN_CADA_MS) {
    ultimoResumenMs = millis();
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
    imprimirResumen();
  }
}
