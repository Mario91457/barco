#pragma once
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <string>
#include <deque>
#define __AVR_ATmega328P__ 1
#define F_CPU 16000000L
#define PROGMEM
#define F(x) x
#define OUTPUT 1
#define _BV(b) (1<<(b))
enum { ICF1=5, OCF1A=1, OCF1B=2, TOV1=0, COM1A1=7, COM1B1=5, WGM11=1, WGM13=4, WGM12=3, CS11=1 };
extern uint16_t TCCR1A,TCCR1B,TCNT1,ICR1,OCR1A,OCR1B,TIFR1; extern uint8_t MCUSR;
extern uint32_t g_us;
inline unsigned long micros(){ return g_us; }
inline unsigned long millis(){ return g_us/1000; }
inline void delay(unsigned long ms){ g_us += ms*1000UL; }
inline void pinMode(int,int){}
inline long map(long x,long a,long b,long c,long d){ return (x-a)*(d-c)/(b-a)+c; }
#define constrain(amt,low,high) ((amt)<(low)?(low):((amt)>(high)?(high):(amt)))
#define min(a,b) ((a)<(b)?(a):(b))
#define max(a,b) ((a)>(b)?(a):(b))
// --- NeoSWSerial ---
struct NeoSWSerial {
  std::deque<char> in; std::string out;
  NeoSWSerial(int,int){} void begin(long){}
  int available(){ return (int)in.size(); }
  int read(){ if(in.empty()) return -1; char c=in.front(); in.pop_front(); return (unsigned char)c; }
  void print(const char*s){ out+=s; } void print(char c){ out+=c; } void print(int v){ out+=std::to_string(v); }
  void println(int v){ out+=std::to_string(v)+"\n"; }
};
// --- Wire ---
extern int g_gyroZ, g_ax, g_ay, g_az;
struct TwoWire {
  uint8_t reg=0; int n=0; uint8_t buf[8]; int pos=0; bool first=true;
  void begin(){} void setClock(long){} void setWireTimeout(uint32_t,bool){}
  void beginTransmission(uint8_t){ first=true; }
  size_t write(uint8_t v){ if(first){ reg=v; first=false; } return 1; }
  uint8_t endTransmission(bool=true){ return 0; }
  uint8_t requestFrom(uint8_t,uint8_t q,uint8_t){
    n=q; pos=0;
    for(int i=0;i<q;i++){ uint8_t r=reg+i; int v=0; bool hi=true;
      if(reg==0x75) buf[i]=0x70;
      else if(reg==0x47){ buf[i]= i==0 ? ((g_gyroZ>>8)&0xFF) : (g_gyroZ&0xFF); }
      else if(reg==0x3B){ int vals[3]={g_ax,g_ay,g_az}; int k=i/2; buf[i]= (i%2==0)? ((vals[k]>>8)&0xFF):(vals[k]&0xFF); }
      else buf[i]=0; (void)r;(void)v;(void)hi; }
    return q; }
  int available(){ return n-pos; } int read(){ return pos<n? buf[pos++] : -1; }
};
extern TwoWire Wire; extern NeoSWSerial* g_bt;
