const markets=[['Nifty 50',22000,1],['Sensex',74000,3],['Bank Nifty',50000,2],['Natural Gas',300,.5,'NATURALGAS'],['Crude Oil',6000,5,'CRUDEOIL'],['Gold',110000,10,'GOLD'],['Silver',90000,10,'SILVER']]
const duration={FIVE_MINUTE:300000,FIFTEEN_MINUTE:900000,ONE_HOUR:3600000}
function fixture(row=markets[0],direction=1,interval='FIVE_MINUTE',now=Date.parse('2026-10-26T14:00:00+05:30'),family='ACCEPTED_BREAK',count=52){
 const [instrument,base,scale,root]=row,times=[],step=duration[interval]
 for(let day=14;day>=0;day--){const date=new Date(now-day*86400000).toISOString().slice(0,10);if([0,6].includes(new Date(date).getUTCDay()))continue
  const open=Date.parse(date+'T'+(root?'09:00':'09:15')+':00+05:30'),close=Date.parse(date+'T'+(root?'23:00':'15:30')+':00+05:30')
  for(let time=open;time+step<=Math.min(close,now);time+=step)times.push(time)
 }
 const candle=(time,o,h,l,c,v=150)=>[new Date(time).toISOString(),base+direction*o*scale,base+(direction===1?h:-l)*scale,base+(direction===1?l:-h)*scale,base+direction*c*scale,root?v:0]
 const slots=times.slice(-count),candles=slots.map((time,i)=>{const level=(i-(count-52))*.1;return candle(time,level,level+1.5,level-1.4,level+.1,100)})
 if(family==='PULLBACK'){
  candles[count-2]=candle(slots[count-2],5.2,5.4,3.9,4.3)
  candles[count-1]=candle(slots[count-1],4.3,6.4,4.2,6.2)
 }else{
  candles[count-2]=candle(slots[count-2],5,7,4.9,6.8)
  candles[count-1]=candle(slots[count-1],6.8,8.5,6.45,8.2)
 }
 return {instrument,base,scale,root,candles,candle,slots,now,side:direction===1?'CALL':'PUT'}
}
function reversalFixture(row=markets[0],direction=1,interval='FIVE_MINUTE',now=Date.parse('2026-10-26T14:00:00+05:30')){
 const f=fixture(row,direction,interval,now)
 const bars=f.slots.map((time,i)=>{const v=(50-i)*.1+Math.sin(i*Math.PI/4)*1.2;return f.candle(time,v,v+1.5,v-1.4,v+.1,100)})
 const peaks=[]
 for(let i=2;i<48;i++)if([i-2,i-1,i+1,i+2].every(j=>direction===1?bars[i][2]>bars[j][2]:bars[i][3]<bars[j][3]))peaks.push(direction===1?bars[i][2]:bars[i][3])
 const level=(peaks.at(-1)-f.base)/(direction*f.scale),open=(bars[49][4]-f.base)/(direction*f.scale)
 bars[50]=f.candle(f.slots[50],open,level+.5,Math.min(open,level)-.1,level+.4)
 bars[51]=f.candle(f.slots[51],level+.4,level+1.6,level+.2,level+1.4)
 return {...f,candles:bars}
}
module.exports={markets,fixture,reversalFixture,duration}
