// Prueba de escritorio del protocolo del firmware: incluye el .ino tal cual con mocks de
// Arduino/Wire/NeoSWSerial y ejecuta checksum, ANG, PMAX, failsafe, PID y CAL.
// Uso: ./run.sh   (necesita g++ y node). No sustituye a las pruebas en hardware.
#include "mock_arduino.h"
uint16_t TCCR1A,TCCR1B,TCNT1,ICR1,OCR1A,OCR1B,TIFR1; uint8_t MCUSR; uint32_t g_us=0;
int g_gyroZ=0,g_ax=0,g_ay=0,g_az=16384; TwoWire Wire;
int g_wdt_resets=0,g_wdt_enabled=0,g_wdt_disables=0;
#include "frames.h"
#include FIRMWARE
static int fails=0, checks=0;
#define CHECK(c) do{ checks++; if(!(c)){ fails++; printf("  FALLA línea %d: %s\n",__LINE__,#c);} }while(0)
static void feed(const char*s){ for(;*s;++s) BT.in.push_back(*s); }
static void step(int ms){ for(int i=0;i<ms;i++){ g_us+=1000; loop(); } }
static int pulseUs(uint16_t c){ return (c+1)/2; }
static void tx(const char*s){ feed(s); step(3); }
int main(){
  setup();
  printf("[setup] mpu=%d wdtEnable=%d wdtDisable=%d\n",mpuDisponible,g_wdt_enabled,g_wdt_disables);
  CHECK(mpuDisponible); CHECK(g_wdt_enabled==1);
  CHECK(pulseUs(OCR1A)==ESC_STOP_US);
  int w0=g_wdt_resets; step(10); CHECK(g_wdt_resets-w0>=10);               // loop() alimenta el watchdog

  printf("[checksum] tramas dañadas se descartan\n");
  tx(FR_PMAX50); CHECK(motorPotenciaMax==50);
  tx(FR_P20); CHECK(potenciaActual==20);
  tx(FR_BAD_DROPDIGIT); CHECK(potenciaActual==20);                          // P2 con sumatoria de P20 -> descartada
  tx(FR_NOSUM); CHECK(potenciaActual==20);                                  // sin checksum -> descartada
  tx(FR_BADHEX); CHECK(potenciaActual==20);
  tx(FR_SHORT); CHECK(potenciaActual==20);
  tx(FR_P0); CHECK(potenciaActual==0);
  tx(FR_BAD_D9); CHECK(direccionAplicada==90);                              // D9 dañada no mueve el servo
  tx(FR_D120); CHECK(direccionAplicada==120);
  tx(FR_KP_EXP); CHECK(pidP==PID_DEFAULT_KP);

  printf("[tope de potencia] PMAX\n");
  tx(FR_P80); CHECK(potenciaActual==50);                                   // P80 recortado al tope
  { int p=pulseUs(OCR1A); CHECK(p==potenciaAPulsoESC(50)); }
  tx(FR_P0);

  printf("[ANG] calibración del servo\n");
  tx(FR_ANG_BAD); CHECK(servoCentro==90);                                   // 999 fuera de rango
  tx(FR_ANG); CHECK(servoCentro==95 && servoBabor==130 && servoEstribor==70);
  CHECK(servoLimiteMin==70 && servoLimiteMax==130);
  CHECK(direccionAplicada==95 || direccionAplicada==120);                   // reposicionado/centro
  feed("C"); step(60); CHECK(direccionAplicada==95);                        // 'C' suelto: centro calibrado
  feed("L"); step(3); CHECK(direccionAplicada==130 && potenciaActual==DEFAULT_SPEED);
  feed("R"); step(3); CHECK(direccionAplicada==70);
  feed("F"); step(3); CHECK(direccionAplicada==95);
  feed("S"); step(3); CHECK(potenciaActual==0);
  feed("H"); step(60); CHECK(direccionAplicada==70);                        // H suelto con timeout 40 ms
  feed("S"); step(3);

  printf("[failsafe] centra con la calibración\n");
  tx(FR_P20); tx(FR_D120);
  CHECK(potenciaActual==20 && direccionAplicada==120);
  step(1800); CHECK(potenciaActual==0 && direccionAplicada==95);

  printf("[ANG/PMAX no renuevan el failsafe]\n");
  tx(FR_P20); step(1000); tx(FR_ANG); tx(FR_PMAX50); step(700);
  CHECK(potenciaActual==0);                                                  // 1,7 s desde P20 aunque llegaron ANG/PMAX

  printf("[PID] sentido de corrección según la calibración\n");
  tx(FR_PID1); tx(FR_CRU1); CHECK(pidActivo && cruceroActivo);
  // yaw positivo (giro a estribor) => el timón debe ir a babor (130 con ANG 95/130/70)
  g_gyroZ = (int)(30*GYRO_LSB_PER_DPS);     // +30 °/s
  step(300);
  printf("   yaw=%.1f servo=%d (centro=95, babor=130, estribor=70)\n",yawRelativo,direccionAplicada);
  CHECK(yawRelativo>5.0f); CHECK(direccionAplicada>95 && direccionAplicada<=130);
  g_gyroZ=0;
  // calibración invertida: estribor 120 > centro 90 => el sentido se invierte solo
  tx(FR_ANG_REV); tx(FR_CRU1);                                               // CRU,1 recaptura rumbo
  yawRelativo=0; rumboObjetivo=0; g_gyroZ=(int)(30*GYRO_LSB_PER_DPS); step(300);
  printf("   yaw=%.1f servo=%d (centro=90, babor=60, estribor=120)\n",yawRelativo,direccionAplicada);
  CHECK(direccionAplicada<90 && direccionAplicada>=60);                      // hacia babor=60
  g_gyroZ=0;
  // el PID nunca sale de los límites calibrados
  g_gyroZ=(int)(200*GYRO_LSB_PER_DPS); step(500);
  CHECK(direccionAplicada>=60 && direccionAplicada<=120);
  g_gyroZ=0;

  printf("[HOLD] se acepta con checksum\n");
  tx(FR_D120); CHECK(cruceroManualActivo);
  tx(FR_HOLD); CHECK(!cruceroManualActivo);

  printf("[CAL] descarta lo recibido durante la calibración\n");
  tx(FR_P0);
  feed(FR_CAL); feed(FR_P20);                                                // P20 llega 'durante' CAL
  step(3);
  CHECK(potenciaActual==0);

  printf("[telemetría] yaw con signo configurado\n");
  tx(FR_TEL1); step(400);
  CHECK(BT.out.find("T,")!=std::string::npos);

  printf("\n%d comprobaciones, %d fallos\n",checks,fails);
  return fails?1:0;
}
