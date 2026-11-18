#!/bin/bash
set -e
cd "$(dirname "$0")"
FW="$(pwd)/../../arduino/barco_control.ino"
node genframes.mjs > /dev/null
g++ -std=c++11 -O0 -w -Imock -I. -DFIRMWARE="\"$FW\"" -D'__attribute__(x)=' test_fw.cpp -o "${TMPDIR:-/tmp}/barco_test_fw"
"${TMPDIR:-/tmp}/barco_test_fw"
