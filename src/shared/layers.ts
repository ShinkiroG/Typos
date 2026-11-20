/**
 * Camadas de um trecho da timeline, como o plano do render (renderer) descreve e o ffmpeg (main) compila.
 * Só tipos, sem DOM e sem Node: o renderer, o preload e o main usam este arquivo.
 */

/** camada de vídeo (clipe, imagem ou lettering): tempos na timeline, já com os crossfades */
export interface VLayer {
  path: string
  image: boolean
  t0: number
  t1: number
  /** segundo do arquivo que toca em t0 */
  src0: number
  /** fades de opacidade (s) a partir das bordas da camada */
  fadeIn: number
  fadeOut: number
  /** sem transparência (vídeo comum, JPG): quando é a camada de baixo e ocupa a parte toda, dispensa o fundo preto e o alfa */
  opaque?: boolean
  /** opaca e cobre o quadro inteiro: enquanto está 100% visível, o que fica embaixo não aparece */
  covers?: boolean
}

/** trecho de áudio: tempos na timeline e o envelope de volume (s desde t0, ganho linear) */
export interface ALayer {
  path: string
  /** limpeza de ruído: o render troca o path pela cópia limpa antes de montar o comando */
  denoise?: 1 | 2 | 3
  /** controle dos picos da voz: entra na mesma cópia tratada */
  peaks?: 1 | 2 | 3
  t0: number
  t1: number
  src0: number
  env: [number, number][]
}
