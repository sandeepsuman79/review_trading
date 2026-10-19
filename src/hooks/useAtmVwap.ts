import { tradingSession } from '../analysis/tradingSession'
import { useEffect, useRef, useState } from 'react'
import { getAtmVwap, type AtmVwapSnapshot } from '../api/atmVwap'
export function useAtmVwap(instrument: string, price: number | undefined, now: number, enabled: boolean) {
  const latestPrice = useRef(price); latestPrice.current = price
  const boundary = Math.floor(now / 60_000), hasPrice = price !== undefined && price > 0
  const atmStrike = hasPrice ? Math.round(price! / (instrument === 'Nifty 50' ? 50 : 100)) : undefined
  const session = tradingSession(now)
  const sessionOpen = session.weekday && session.minute >= 555 && session.minute <= 930
  const [state,setState] = useState<{ instrument: string; data?: AtmVwapSnapshot; error?: string }>({instrument})
  useEffect(() => {
    if (!enabled || !hasPrice || !sessionOpen) return
    let timedOut = false
    const controller = new AbortController(), timeout = window.setTimeout(()=>{timedOut=true;controller.abort()},55_000)
    void getAtmVwap(instrument,latestPrice.current!,controller.signal).then(data=>{if(!controller.signal.aborted)setState({instrument,data})}).catch(error=>{if(!controller.signal.aborted||timedOut)setState(previous => ({instrument,data:previous.instrument === instrument ? previous.data : undefined,error:timedOut?'ATM candle request timed out. Technical protection continues.':error instanceof Error?error.message:'ATM option VWAP unavailable.'}))}).finally(()=>window.clearTimeout(timeout))
    return ()=>{window.clearTimeout(timeout);controller.abort()}
  },[instrument,boundary,hasPrice,enabled,atmStrike,sessionOpen])
  return state.instrument===instrument?state:{instrument}
}
