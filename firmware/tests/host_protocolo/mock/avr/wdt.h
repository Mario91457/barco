#pragma once
extern int g_wdt_resets, g_wdt_enabled, g_wdt_disables;
#define WDTO_500MS 5
static inline void wdt_reset(){ g_wdt_resets++; }
static inline void wdt_enable(int){ g_wdt_enabled++; }
static inline void wdt_disable(){ g_wdt_disables++; }
