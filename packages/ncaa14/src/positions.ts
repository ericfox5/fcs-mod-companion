// PPOS codes (from the game's PPOS enumeration).
export const POSITIONS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'] as const;
export type Position = (typeof POSITIONS)[number];
export function positionName(code: number): string { return POSITIONS[code] ?? `POS${code}`; }
export const POSITION_GROUPS: Record<string, string[]> = {
  QB: ['QB'], RB: ['HB', 'FB'], WR: ['WR'], TE: ['TE'], OL: ['LT', 'LG', 'C', 'RG', 'RT'],
  DL: ['LE', 'RE', 'DT'], LB: ['LLB', 'MLB', 'RLB'], DB: ['CB', 'FS', 'SS'], ST: ['K', 'P'],
};
export const YEARS = ['FR', 'SO', 'JR', 'SR'] as const;
export function classYear(pyea: number, redshirt: number): string { return (redshirt ? 'RS ' : '') + (YEARS[pyea] ?? `Y${pyea}`); }
