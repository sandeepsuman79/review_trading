const intervals = { FIVE_MINUTE: 300000, FIFTEEN_MINUTE: 900000, ONE_HOUR: 3600000 }
const markets = [['Nifty 50',22000,10],['Sensex',74000,30],['Bank Nifty',50000,20],['Natural Gas',300,.2,'NATURALGAS'],['Crude Oil',6000,5,'CRUDEOIL'],['Gold',110000,100,'GOLD'],['Silver',90000,100,'SILVER']]
function scenario(row, direction, interval='FIVE_MINUTE', date='2026-10-16', kind='continuation') {
 const [instrument,base,scale,root]=row, duration=intervals[interval]
 const now=Date.parse(`${date}T${root?'14:00':'14:15'}:00+05:30`), times=[]
 for(let days=20;days>=0;days--){
  const day=new Date(now-days*86400000)
  if([0,6].includes(day.getUTCDay()))continue
  const open=Date.parse(`${day.toISOString().slice(0,10)}T${root?'09:00':'09:15'}:00+05:30`)
  const close=open+(root?14.5:6.25)*3600000
  for(let time=open;time+duration<=Math.min(now,close);time+=duration)times.push(time)
 }
 const candles=times.slice(-52).map((time,i)=>{
  let close,open,wick
  if(kind==='impulse'){
   close=base+direction*(i===51?3:Math.sin(i*.8)*.05)*scale
   open=i===51?base:close-direction*.05*scale
   wick=(i===51?.05:.5)*scale
  } else {
   close=base+direction*(i*.4+Math.sin(i*.7+2.1)*.6)*scale
   open=close-direction*.6*scale;wick=(i===51?.05:.4)*scale
  }
  return[new Date(time).toISOString(),open,Math.max(open,close)+wick,Math.min(open,close)-wick,close,root?100:0]
 })
 return {instrument,now,candles,interval,root,scale,base}
}
module.exports={scenario,markets,intervals}
