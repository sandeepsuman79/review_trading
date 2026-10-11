import type { AngelOneStreamTick } from './angelOne'

/** SmartAPI WebSocket 2.0 uses little-endian, signed 64-bit prices and quantities. */
export function decodeStreamPacket(buffer: ArrayBuffer): AngelOneStreamTick {
  const bytes = new DataView(buffer)
  if (bytes.byteLength < 51) throw new Error('Received an invalid Smart Stream packet.')
  const mode = bytes.getUint8(0)
  if (![1, 2, 3].includes(mode) || mode !== 1 && bytes.byteLength < 123) throw new Error('Received an invalid Smart Stream quote packet.')
  const integer = (offset: number) => {
    const value = Number(bytes.getBigInt64(offset, true))
    if (!Number.isSafeInteger(value)) throw new Error('Received an unsafe Smart Stream value.')
    return value
  }
  const token = new TextDecoder().decode(new Uint8Array(buffer, 2, 25)).replace(/\0.*$/, '')
  const tick: AngelOneStreamTick = {
    mode, exchangeType: bytes.getUint8(1), token,
    sequence: integer(27), timestamp: integer(35), ltp: integer(43) / 100,
  }
  if (!token || tick.timestamp <= 0 || tick.ltp! <= 0) throw new Error('Received an invalid Smart Stream price or timestamp.')
  if (mode !== 1) {
    tick.volume = integer(67)
    tick.open = integer(91) / 100
    tick.high = integer(99) / 100
    tick.low = integer(107) / 100
    tick.close = integer(115) / 100
  }
  return tick
}
