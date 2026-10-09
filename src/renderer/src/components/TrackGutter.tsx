import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { Clip, TimelineAsset, Timing } from '../lib'

interface Bar {
  id: string
  top: number
  height: number
  color: string
  label: string
  kind: Clip['kind']
  lane: number
}

const KIND_COLOR: Record<Clip['kind'], string> = { music: '#f5c542', sfx: '#22d3ee', soundUp: '#f472b6' }

/**
 * Barras na margem esquerda do texto mostrando qual música/SFX toca em cada trecho
 * (o mesmo da timeline). A posição sai do tempo de cada bloco: um bloco que dura
 * de 0:10 a 0:20 ocupa a altura dele no texto, e o tempo é distribuído nessa altura.
 */
export function TrackGutter({ editor, timing, clips, assets }: { editor: Editor | null; timing: Timing; clips: Clip[]; assets: TimelineAsset[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [bars, setBars] = useState<Bar[]>([])

  const measure = useCallback(() => {
    const el = ref.current
    if (!el || !editor || editor.isDestroyed || !clips.length) return setBars([])
    const base = el.getBoundingClientRect().top
    const blocks: { t0: number; t1: number; top: number; bottom: number }[] = []
    let i = 0
    editor.state.doc.forEach((_node, offset) => {
      const t0 = timing.blockStarts[i] ?? 0
      const t1 = timing.blockStarts[i + 1] ?? timing.total
      i++
      const dom = editor.view.nodeDOM(offset)
      if (!(dom instanceof HTMLElement) || dom.offsetParent === null) return // escondido por filtro
      const r = dom.getBoundingClientRect()
      blocks.push({ t0, t1, top: r.top - base, bottom: r.bottom - base })
    })
    if (!blocks.length) return setBars([])

    const yAt = (t: number) => {
      let b = blocks[0]
      for (const x of blocks) {
        if (x.t0 <= t + 1e-6) b = x
        else break
      }
      if (t >= timing.total) return blocks[blocks.length - 1].bottom
      const f = b.t1 > b.t0 ? Math.min(1, Math.max(0, (t - b.t0) / (b.t1 - b.t0))) : 0
      return b.top + f * (b.bottom - b.top)
    }

    setBars(
      clips.map((c) => {
        const a = c.assetId ? assets.find((x) => x.id === c.assetId) : undefined
        const top = yAt(c.start)
        const bottom = yAt(c.start + c.duration)
        return {
          id: c.id,
          top,
          height: Math.max(8, bottom - top),
          color: a?.color ?? KIND_COLOR[c.kind],
          label: a?.name ?? c.name,
          kind: c.kind,
          lane: c.lane
        }
      })
    )
  }, [editor, timing, clips, assets])

  useLayoutEffect(measure, [measure])

  // texto mudou de tamanho (janela, filtros, imagens carregando) → remede
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(editor.view.dom)
    return () => ro.disconnect()
  }, [editor, measure])

  return (
    <div className="track-gutter" ref={ref}>
      {bars.map((b) => (
        <div
          key={b.id}
          className={'tg-bar k-' + b.kind}
          style={{ top: b.top, height: b.height, right: `calc(100% + ${14 + b.lane * 22}px)`, ['--bc' as any]: b.color }}
          title={`${b.label} (${b.kind === 'sfx' ? 'SFX' : b.kind === 'soundUp' ? 'sobe som' : 'música'})`}
        >
          <span className="tg-label">{b.label}</span>
        </div>
      ))}
    </div>
  )
}
