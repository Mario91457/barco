import fs from 'fs';
import { fileURLToPath } from 'url';
// Genera frames.h con tramas calculadas por el checksumXor REAL de src/main.js.
const src = fs.readFileSync(fileURLToPath(new URL('../../../../app/src/main.js', import.meta.url)),'utf8');
const m = /function checksumXor\(orden\) \{[\s\S]*?\n    \}/.exec(src);
const checksumXor = eval('(' + m[0].replace('function checksumXor','function') + ')');
const enc = o => `${o}*${checksumXor(o)}\n`;
const damaged = o => enc(o).replace(/\*([0-9A-F]{2})/, (_, h) => `*${h === '00' ? '01' : '00'}`);
const esc = s => JSON.stringify(s);
const defs = {
  FR_PMAX50: enc('PMAX,50'), FR_P80: enc('P80'), FR_P20: enc('P20'), FR_P0: enc('P0'),
  FR_ANG: enc('ANG,95,130,70'), FR_ANG_REV: enc('ANG,90,60,120'), FR_ANG_BAD: enc('ANG,90,60,999'),
  FR_CRU1: enc('CRU,1,KP=2.0,KI=0.00,KD=0.4'),
  FR_CRU_UPDATE: enc('CRU,1,KP=5.0,KI=0.1,KD=2.5'),
  FR_CRU_RANGE_BAD: enc('CRU,1,KP=51,KI=0,KD=0.4'),
  FR_CRU_FORMAT_BAD: enc('CRU,1,KP=2,KI=0,KD=0.4,EXTRA=1'),
  FR_CRU_BAD_CHECKSUM: damaged('CRU,1,KP=3,KI=0,KD=1'),
  FR_CRU_OFF: enc('CRU,0'), FR_CRU_OLD: enc('CRU,1'), FR_PID_OLD: enc('PID,1'),
  FR_HOLD: enc('HOLD'), FR_CAL: enc('CAL'), FR_TEL1: enc('TEL,1'),
  FR_D120: enc('D120'),
  // dañadas
  FR_BAD_DROPDIGIT: 'P2*' + checksumXor('P20') + '\n',        // se perdió un dígito
  FR_BAD_D9: 'D9*' + checksumXor('D90') + '\n',               // D90 -> D9
  FR_NOSUM: 'P30\n', FR_BADHEX: 'P30*ZZ\n', FR_SHORT: 'P30*5\n',
  FR_KP: enc('KP,' + String(Number((0.30000000000000004).toFixed(3)))),
  FR_KP_EXP: 'KP,1e-7*00\n',
};
fs.writeFileSync('frames.h', Object.entries(defs).map(([k,v])=>`#define ${k} ${esc(v)}`).join('\n')+'\n');
console.log(Object.entries(defs).map(([k,v])=>k+' '+JSON.stringify(v)).join('\n'));
