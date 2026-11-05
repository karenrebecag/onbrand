/** Graba el micrófono como v0: MediaRecorder entero y una sola transcripción al soltar, no dictado en vivo.
 * El nivel sale de un AnalyserNode para que la onda del composer siga la voz real. */
export interface Recorder {
  start: () => Promise<void>
  stop: () => Promise<Blob>
  cancel: () => void
  /** 0..1, el RMS del último cuadro; 0 si no se está grabando. */
  level: () => number
}

// Safari no graba webm; el primero que el navegador soporte gana.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

export function createRecorder(): Recorder {
  let media: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let audio: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let chunks: Blob[] = []
  const frame = new Uint8Array(1024)

  const release = () => {
    stream?.getTracks().forEach((t) => t.stop())
    void audio?.close()
    media = null
    stream = null
    audio = null
    analyser = null
  }

  return {
    async start() {
      if (media) return
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
      media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunks = []
      media.ondataavailable = (e) => { if (e.data.size) chunks = [...chunks, e.data] }
      media.start()
      audio = new AudioContext()
      analyser = audio.createAnalyser()
      analyser.fftSize = frame.length
      audio.createMediaStreamSource(stream).connect(analyser)
    },
    stop() {
      const current = media
      if (!current) return Promise.reject(new Error('No hay grabación en curso'))
      return new Promise<Blob>((resolve) => {
        current.onstop = () => {
          const blob = new Blob(chunks, { type: current.mimeType || 'audio/webm' })
          release()
          resolve(blob)
        }
        current.stop()
      })
    },
    cancel() {
      if (media && media.state !== 'inactive') media.stop()
      release()
    },
    level() {
      if (!analyser) return 0
      analyser.getByteTimeDomainData(frame)
      let sum = 0
      for (const v of frame) sum += ((v - 128) / 128) ** 2
      // La voz normal queda en un RMS de ~0.05-0.2; se escala para que la onda se mueva visiblemente.
      return Math.min(1, Math.sqrt(sum / frame.length) * 4)
    },
  }
}
