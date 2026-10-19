import type { AngelOneStreamTick } from '../api/angelOne'
import { tickTimestamp } from './candleData'

type Identity = Pick<AngelOneStreamTick, 'token' | 'exchangeType'>
type Sample = { time: number; price: number; volume?: number }
type Observations = { lastAt: number; session: string; samples: Sample[]; volumeBreakAt?: number }
export type IntrabarContext = {
  state: 'WARMING_UP' | 'STALE' | 'OBSERVED'
  key?: string
  sampleCount: number
  spanMs: number
  firstAt?: number
  lastAt?: number
  priceChange?: number
  priceChangePercent?: number
  cumulativeVolumeDelta?: number
}

const windowMs = 30_000, minimumSpanMs = 5_000, maximumKeys = 32, maximumSamples = 180
function identityKey(identity: Identity) {
  return typeof identity.token === 'string' && identity.token.length > 0 && identity.token.length <= 128 && identity.token.trim() === identity.token
    && Number.isSafeInteger(identity.exchangeType) && identity.exchangeType > 0 ? `${identity.exchangeType}:${identity.token}` : undefined
}
function sessionAt(time: number) {
  const date = new Date(time + 330 * 60_000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined
}

/** Read-only context from actual received quotes. Samples are observations, never traded volume. */
export function createIntrabarContextStore() {
  const observations = new Map<string, Observations>()
  function recordIntrabarTick(tick: AngelOneStreamTick, now = Date.now()) {
    const key = identityKey(tick), time = tickTimestamp(tick), price = tick.ltp
    if (!key || !Number.isFinite(now) || !Number.isFinite(time) || time <= 0 || !Number.isFinite(new Date(time).getTime())
      || now - time > windowMs || time - now > 1_000 || !Number.isFinite(price) || price! <= 0) return false
    const previous = observations.get(key)
    if (previous && time <= previous.lastAt) return false
    const session = sessionAt(time)
    if (!session) return false
    const sameSession = previous?.session === session
    const samples = sameSession ? previous.samples.filter(sample => time - sample.time <= windowMs) : []
    const volume = Number.isFinite(tick.volume) && tick.volume! >= 0 ? tick.volume : undefined
    const previousVolume = samples[samples.length - 1]?.volume
    const volumeBreakAt = sameSession && samples.length && (volume === undefined || previousVolume === undefined || volume < previousVolume)
      ? time : sameSession ? previous.volumeBreakAt : undefined
    samples.push({ time, price: price!, ...(volume !== undefined ? { volume } : {}) })
    // If ticks are dense, discard interior observations so the observed window still has a real baseline.
    while (samples.length > maximumSamples) samples.splice(1, 1)
    observations.delete(key)
    observations.set(key, { lastAt: time, session, samples, volumeBreakAt })
    while (observations.size > maximumKeys) observations.delete(observations.keys().next().value!)
    return true
  }
  function readIntrabarContext(identity: Identity | string, now = Date.now()): IntrabarContext {
    const key = typeof identity === 'string' ? identity : identityKey(identity)
    const stored = key === undefined ? undefined : observations.get(key)
    const empty: IntrabarContext = { state: 'WARMING_UP', key, sampleCount: 0, spanMs: 0 }
    if (!stored) return empty
    if (!Number.isFinite(now) || now - stored.lastAt > windowMs || stored.lastAt - now > 1_000) return { ...empty, state: 'STALE', lastAt: stored.lastAt }
    const samples = stored.samples.filter(sample => now - sample.time <= windowMs && sample.time - now <= 1_000)
    const first = samples[0], last = samples[samples.length - 1]
    const spanMs = first && last ? last.time - first.time : 0
    const base: IntrabarContext = { ...empty, sampleCount: samples.length, spanMs, firstAt: first?.time, lastAt: stored.lastAt }
    if (!first || !last || samples.length < 2 || spanMs < minimumSpanMs) return base
    const priceChange = last.price - first.price
    const percent = priceChange / first.price * 100
    const result: IntrabarContext = { ...base, state: 'OBSERVED', priceChange, ...(Number.isFinite(percent) ? { priceChangePercent: percent } : {}) }
    const volumes = samples.map(sample => sample.volume)
    if ((stored.volumeBreakAt === undefined || first.time >= stored.volumeBreakAt)
      && volumes.every((volume, index) => volume !== undefined && Number.isFinite(volume) && volume >= 0 && (index === 0 || volume >= volumes[index - 1]!))) {
      const delta = volumes[volumes.length - 1]! - volumes[0]!
      if (Number.isFinite(delta)) result.cumulativeVolumeDelta = delta
    }
    return result
  }
  return { recordIntrabarTick, readIntrabarContext, stats: () => ({ keys: observations.size, samples: [...observations.values()].reduce((sum, entry) => sum + entry.samples.length, 0), maximumKeys, maximumSamples }) }
}

const store = createIntrabarContextStore()
export const recordIntrabarTick = store.recordIntrabarTick
export const readIntrabarContext = store.readIntrabarContext
