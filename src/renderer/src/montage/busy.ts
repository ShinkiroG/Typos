import type { BlockBusy } from './BlockPanel'

/** quantos blocos podem gerar motion ao mesmo tempo (a espera do Claude se sobrepõe; a gravação vai em fila) */
export const MAX_PARALLEL = 2

export type BusyMap = Record<string, BlockBusy>

/** dá pra começar esse bloco agora? (ele não está ocupado e ainda tem vaga) */
export function canStart(map: BusyMap, id: string) {
  return !map[id] && Object.keys(map).length < MAX_PARALLEL
}

/**
 * O que os painéis de um bloco recebem como `busy`: o progresso dele; se ele está livre mas as vagas
 * acabaram, o de outro bloco (os botões ficam desligados com o aviso); senão nada.
 */
export function busyFor(map: BusyMap, id: string): BlockBusy | null {
  if (map[id]) return map[id]
  const all = Object.values(map)
  return all.length >= MAX_PARALLEL ? all[0] : null
}

/** troca (ou tira, com null) o progresso de um bloco; função recebe o atual */
export function withBusy(map: BusyMap, id: string, next: BlockBusy | null | ((cur: BlockBusy | undefined) => BlockBusy | null)): BusyMap {
  const v = typeof next === 'function' ? next(map[id]) : next
  if (!v) {
    if (!(id in map)) return map
    const { [id]: _, ...rest } = map
    return rest
  }
  return { ...map, [id]: v }
}

/** aviso dos botões quando as vagas acabaram */
export const FULL_HINT = `Já tem ${MAX_PARALLEL} motions sendo feitos. Espere um terminar.`
