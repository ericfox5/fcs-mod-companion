// Overall rating formulas per PPOS: OVR = sum(field * weight) + adjustment, from Xan's NCAA 14 Roster Config (EA DB
// Editor), the model the roster tools build ratings with (FCS/Rosters/2026/ratings/xan_ovr_formulas.json). No formula
// for 24 (LS): LS rows are rated with the TE formula by the callers.
export interface OvrFormula { vars: [string, number][]; adjustment: number }
export const OVR_FORMULAS: Record<number, OvrFormula> = {
  0: { vars: [['PSPD', 0.15], ['PAGI', 0.03], ['PACC', 0.03], ['PAWR', 0.35], ['PBTK', 0.03], ['PTRK', 0.01], ['PESV', 0.01], ['PTHP', 0.535], ['PTHA', 0.6]], adjustment: -58 },
  1: { vars: [['PSPD', 0.4], ['PAWR', 0.1], ['PCAR', 0.19], ['PBCV', 0.1], ['PAGI', 0.1], ['PACC', 0.19], ['PBTK', 0.4], ['PTRK', 0.02], ['PESV', 0.02], ['PSMV', 0.02], ['PJMV', 0.02], ['PSTR', 0.05], ['PCTH', 0.1], ['PSAR', 0.02]], adjustment: -58.5 },
  2: { vars: [['PSPD', 0.16], ['PAWR', 0.08], ['PCAR', 0.16], ['PBCV', 0.08], ['PAGI', 0.08], ['PACC', 0.03], ['PBTK', 0.16], ['PTRK', 0.01], ['PESV', 0.01], ['PRBK', 0.71], ['PPBK', 0.16], ['PIBL', 0.08], ['PSTR', 0.08], ['PCTH', 0.08], ['PSAR', 0.01]], adjustment: -63 },
  3: { vars: [['PSPD', 0.36], ['PSTR', 0.01], ['PAGI', 0.14], ['PACC', 0.22], ['PAWR', 0.07], ['PBTK', 0.07], ['PTRK', 0.01], ['PESV', 0.01], ['PBCV', 0.01], ['PSAR', 0.01], ['PSMV', 0.01], ['PJMV', 0.01], ['PCAR', 0.01], ['PCTH', 0.36], ['SPCT', 0.03], ['TRAF', 0.07], ['PRTR', 0.14], ['PJMP', 0.03], ['RELS', 0.07]], adjustment: -51 },
  4: { vars: [['PSPD', 0.18], ['PSTR', 0.04], ['PAGI', 0.09], ['PACC', 0.04], ['PAWR', 0.09], ['PBTK', 0.09], ['PTRK', 0.01], ['PESV', 0.01], ['PBCV', 0.01], ['PSAR', 0.01], ['PSMV', 0.01], ['PJMV', 0.01], ['PCAR', 0.01], ['PCTH', 0.18], ['TRAF', 0.09], ['PRTR', 0.13], ['PJMP', 0.01], ['RELS', 0.01], ['PPBK', 0.27], ['PRBK', 0.46], ['PIBL', 0.04]], adjustment: -55 },
  5: { vars: [['PSPD', 0.05], ['PSTR', 0.16], ['PAGI', 0.06], ['PACC', 0.06], ['PAWR', 0.08], ['PPBK', 0.58], ['PRBK', 0.58], ['PIBL', 0.08]], adjustment: -55 },
  6: { vars: [['PSPD', 0.05], ['PSTR', 0.17], ['PAGI', 0.06], ['PACC', 0.08], ['PAWR', 0.09], ['PPBK', 0.53], ['PRBK', 0.61], ['PIBL', 0.08]], adjustment: -56 },
  7: { vars: [['PSPD', 0.05], ['PSTR', 0.18], ['PAGI', 0.06], ['PACC', 0.06], ['PAWR', 0.09], ['PPBK', 0.54], ['PRBK', 0.64], ['PIBL', 0.09]], adjustment: -57 },
  8: { vars: [['PSPD', 0.05], ['PSTR', 0.17], ['PAGI', 0.06], ['PACC', 0.08], ['PAWR', 0.09], ['PPBK', 0.53], ['PRBK', 0.61], ['PIBL', 0.08]], adjustment: -56 },
  9: { vars: [['PSPD', 0.05], ['PSTR', 0.16], ['PAGI', 0.06], ['PACC', 0.06], ['PAWR', 0.08], ['PPBK', 0.58], ['PRBK', 0.58], ['PIBL', 0.08]], adjustment: -55 },
  10: { vars: [['PSPD', 0.15], ['PSTR', 0.2], ['PAGI', 0.1], ['PACC', 0.15], ['PAWR', 0.1], ['PTAK', 0.31], ['PHIT', 0.1], ['PPMV', 0.1], ['PFMV', 0.1], ['PBSH', 0.2], ['PPRS', 0.1], ['PPRC', 0.1]], adjustment: -53.3 },
  11: { vars: [['PSPD', 0.15], ['PSTR', 0.2], ['PAGI', 0.1], ['PACC', 0.15], ['PAWR', 0.1], ['PTAK', 0.31], ['PHIT', 0.1], ['PPMV', 0.1], ['PFMV', 0.1], ['PBSH', 0.2], ['PPRS', 0.1], ['PPRC', 0.1]], adjustment: -53.3 },
  12: { vars: [['PSPD', 0.1], ['PSTR', 0.3], ['PAGI', 0.1], ['PACC', 0.1], ['PAWR', 0.1], ['PTAK', 0.3], ['PHIT', 0.1], ['PPMV', 0.1], ['PFMV', 0.1], ['PBSH', 0.3], ['PPRS', 0.1], ['PPRC', 0.1]], adjustment: -58 },
  13: { vars: [['PSPD', 0.22], ['PSTR', 0.17], ['PAGI', 0.04], ['PACC', 0.09], ['PAWR', 0.09], ['PTAK', 0.35], ['PHIT', 0.09], ['PPMV', 0.04], ['PFMV', 0.04], ['PBSH', 0.17], ['PPRS', 0.09], ['PPRC', 0.17], ['PMCV', 0.09], ['PZCV', 0.09]], adjustment: -56 },
  14: { vars: [['PSPD', 0.16], ['PSTR', 0.16], ['PAGI', 0.04], ['PACC', 0.08], ['PAWR', 0.08], ['PTAK', 0.41], ['PHIT', 0.08], ['PPMV', 0.04], ['PFMV', 0.04], ['PBSH', 0.16], ['PPRS', 0.08], ['PPRC', 0.24], ['PMCV', 0.08], ['PZCV', 0.08]], adjustment: -55.5 },
  15: { vars: [['PSPD', 0.22], ['PSTR', 0.17], ['PAGI', 0.04], ['PACC', 0.09], ['PAWR', 0.09], ['PTAK', 0.35], ['PHIT', 0.09], ['PPMV', 0.04], ['PFMV', 0.04], ['PBSH', 0.17], ['PPRS', 0.09], ['PPRC', 0.17], ['PMCV', 0.09], ['PZCV', 0.09]], adjustment: -56 },
  16: { vars: [['PSPD', 0.3], ['PSTR', 0.04], ['PAGI', 0.08], ['PACC', 0.16], ['PAWR', 0.08], ['PCTH', 0.04], ['PJMP', 0.04], ['PTAK', 0.08], ['PPRS', 0.08], ['PPRC', 0.08], ['PMCV', 0.28], ['PZCV', 0.28], ['PYRS', 0.08]], adjustment: -54 },
  17: { vars: [['PSPD', 0.25], ['PSTR', 0.04], ['PAGI', 0.08], ['PACC', 0.08], ['PAWR', 0.08], ['PCTH', 0.04], ['PJMP', 0.04], ['PTAK', 0.25], ['PHIT', 0.04], ['PPRS', 0.08], ['PPRC', 0.12], ['PMCV', 0.21], ['PZCV', 0.25], ['PYRS', 0.04]], adjustment: -44.5 },
  18: { vars: [['PSPD', 0.24], ['PSTR', 0.04], ['PAGI', 0.08], ['PACC', 0.08], ['PAWR', 0.08], ['PCTH', 0.04], ['PJMP', 0.04], ['PTAK', 0.32], ['PHIT', 0.08], ['PPRS', 0.08], ['PPRC', 0.12], ['PMCV', 0.16], ['PZCV', 0.24], ['PYRS', 0.05]], adjustment: -48 },
  19: { vars: [['PAWR', 0.04], ['PKPR', 0.46], ['PKAC', 0.5]], adjustment: 0 },
  20: { vars: [['PAWR', 0.04], ['PKPR', 0.5], ['PKAC', 0.46]], adjustment: 0 },
};
