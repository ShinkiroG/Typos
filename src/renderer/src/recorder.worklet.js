// Captura do microfone na thread de áudio (fora da interface): nenhum pedaço se perde
// quando a tela está ocupada (teleprompter, timeline tocando…), então não sai "pop".
class TyposRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.on = false
    this.buf = new Float32Array(16384)
    this.n = 0
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.n = 0
        this.on = true
      } else if (e.data === 'stop') {
        this.on = false
        this.flush()
        this.port.postMessage('done')
      }
    }
  }
  flush() {
    if (!this.n) return
    const out = this.buf.slice(0, this.n)
    this.port.postMessage(out, [out.buffer])
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (this.on && ch) {
      if (this.n + ch.length > this.buf.length) this.flush()
      this.buf.set(ch, this.n)
      this.n += ch.length
    }
    return true
  }
}
registerProcessor('typos-recorder', TyposRecorder)
