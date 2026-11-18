#!/bin/sh
# Fang's Recruit Overhaul (a Windows program) through Wine, for ncaa-bridge on the league server. The bridge starts
# this in a work folder that holds your-save-file/USR-DATA and reads what it prints. The tool cannot print to a pipe
# under Wine, so its output goes to a file first.
unset NODE_OPTIONS
export WINEPREFIX=/var/lib/fcs-league/sync/wine WINEDEBUG=-all
/usr/bin/wine64 /var/lib/fcs-league/sync/overhaul-tool/RecruitOverhaul.exe > tool.log 2>&1 < /dev/null
rc=$?
cat tool.log
exit $rc
