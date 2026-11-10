// Playbook JSON as tools/playbooks-extract.mts writes it (worker/public/data/playbooks/<bookId>.json) and as Supersim,
// the Depth Chart page and the Playbook page read it. Ids are the game's own: a formation is a PBFM id, a set a SETL id,
// a play a PLYL id, so the same formation or play keeps its id in every book that lists it.
export interface Book { id: number; bgid: number; side: 'off' | 'def'; name: string; formations: Formation[]; plays: Record<string, Play>; asg: Assign[]; ai: Record<string, number[][]> }
export interface Formation { id: number; n: string; t: number; sets: SetDef[] }
export interface SetDef { id: number; n: string; slots: Slot[]; plays: number[] }
// x: yards to the offense's right, y: yards toward the defense (offense slots negative, defense positive)
export interface Slot { i: number; pos: number; depth: number; x: number; y: number }
// t: PBPL.PLYT play type; sit: SITT; f: PLF_ flags; v: vpos; h: PLRD run hole; prog: [[receiver slot, %]] progression; a: one
// index into asg per slot (poso order), -1 for a slot with no assignment row
export interface Play { id: number; n: string; t: number; sit: number; f: number; v: number; h?: number; prog?: number[][]; a: number[] }
// r: PLRR role; k: kind (offense qb qbpa qbopt handoff carry route screen block pblock kick hold punt kneel spike cover move;
// defense rush man under deep ret block recover); p: path in yards [x right, y downfield] from the slot; c: art end cap
// (1 block T, 2 arrow, 3-5 zone bubbles); t: man-coverage receiver number; z: zone id
export interface Assign { r: number; k: string; p?: number[][]; c?: number; t?: number; z?: number }
export interface BookIndex { generated: string; books: { id: number; bgid: number; side: 'off' | 'def'; name: string; plays: number; formations: string[] }[] }
