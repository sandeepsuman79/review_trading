import { useMemo } from 'react'
import ReactApexChart from 'react-apexcharts'
import type { ApexOptions } from 'apexcharts'
import type { AngelOneCandle } from '../api/angelOne'

export default function CandleVolume({ candles, min, max, name }: { candles: AngelOneCandle[]; min: number; max: number; name: string }) {
  const series = useMemo(() => [{ name: 'Traded volume', data: candles.slice(Math.max(0, Math.floor(min) - 2), Math.ceil(max) + 3).map((bar, i) => ({
    x: Math.max(0, Math.floor(min) - 2) + i, y: bar[5], fillColor: bar[4] >= bar[1] ? '#16A34A' : '#DC2626',
  })) }], [candles, min, max])
  const options = useMemo<ApexOptions>(() => ({
    chart: { type: 'bar', animations: { enabled: false }, toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit' },
    plotOptions: { bar: { columnWidth: '75%' } }, dataLabels: { enabled: false }, legend: { show: false },
    grid: { show: false, padding: { top: -15, bottom: -12, left: 8, right: 8 } },
    xaxis: { type: 'numeric', min, max, labels: { show: false }, axisTicks: { show: false }, axisBorder: { show: false }, tooltip: { enabled: false } },
    yaxis: { min: 0, opposite: true, tickAmount: 2, labels: { formatter: value => Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value), style: { fontSize: '10px' } } },
    tooltip: { x: { formatter: value => {
      const candle = candles[Math.round(Number(value))]
      return candle ? `${new Date(candle[0]).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST` : ''
    } }, y: { formatter: value => value.toLocaleString('en-IN') } },
  }), [candles, min, max])
  return <div className="candle-volume" aria-label={`${name} traded volume chart`}><small>Traded volume · per candle</small><ReactApexChart type="bar" height={100} options={options} series={series} /></div>
}
