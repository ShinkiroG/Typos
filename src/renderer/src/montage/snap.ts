/**
 * Ímã de algo com duração fixa sendo arrastado (corte, bloco, lettering): gruda pela borda que
 * encostou mais perto de alguma coisa. `snap` devolve o tempo encaixado (ou o mesmo, se nada perto).
 * Antes só a borda da esquerda grudava: a de começo "ganhava" mesmo sem ter encaixe nenhum.
 */
export function snapMove(snap: (t: number) => number, start: number, len: number): { start: number; hit: number | null } {
  const off = (a: number, b: number) => Math.abs(a - b) > 1e-6
  const a = snap(start)
  const z = snap(start + len)
  const da = off(a, start) ? Math.abs(a - start) : Infinity
  const dz = off(z, start + len) ? Math.abs(z - start - len) : Infinity
  if (da === Infinity && dz === Infinity) return { start, hit: null }
  return da <= dz ? { start: a, hit: a } : { start: z - len, hit: z }
}
