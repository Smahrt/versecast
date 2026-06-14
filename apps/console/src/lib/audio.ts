/**
 * Mic capture (TDD §4.1): getUserMedia with the selected device,
 * echo cancellation + noise suppression ON, worklet downsampling.
 */
export interface MicCapture {
  stop: () => void
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}

export async function startCapture(
  deviceId: string | null,
  onChunk: (pcm: ArrayBuffer) => void,
  onLevel: (rms: number) => void,
): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  })

  const ctx = new AudioContext()
  await ctx.audioWorklet.addModule('/pcm-worklet.js')
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-processor')
  node.port.onmessage = (e) => {
    if (e.data.type === 'chunk') onChunk(e.data.pcm)
    else if (e.data.type === 'level') onLevel(e.data.rms)
  }
  source.connect(node)
  // worklet has no output; don't connect to destination (no echo)

  return {
    stop() {
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}
