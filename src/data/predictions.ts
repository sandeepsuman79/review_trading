export interface IndexPrediction {
  index: string
  sentiment: 'Bullish' | 'Neutral' | 'Bearish'
  entry: string
  target: string
  stoploss: string
  chance: string
  rationale: string
}

export const predictions: IndexPrediction[] = [
  {
    index: 'Nifty 50',
    sentiment: 'Bullish',
    entry: '19,400 - 19,450',
    target: '19,900',
    stoploss: '19,250',
    chance: 'High (72%)',
    rationale: 'Strong domestic flows, positive FII sentiment, support from global cues and macro data.',
  },
  {
    index: 'Sensex',
    sentiment: 'Bullish',
    entry: '66,100 - 66,300',
    target: '67,200',
    stoploss: '65,600',
    chance: 'Moderate-High (68%)',
    rationale: 'Banking strength and positive corporate earnings outlook are supporting the market.',
  },
  {
    index: 'Bank Nifty',
    sentiment: 'Neutral',
    entry: '44,000 - 44,200',
    target: '44,900',
    stoploss: '43,500',
    chance: 'Moderate (58%)',
    rationale: 'Mixed FII/DII flows and volatile banking earnings create a balanced risk profile.',
  },
  {
    index: 'Nifty IT',
    sentiment: 'Bearish',
    entry: '39,100 - 39,400',
    target: '38,300',
    stoploss: '39,900',
    chance: 'Moderate (60%)',
    rationale: 'Weak global IT demand and profit booking after recent gains are weighing on the sector.',
  },
  {
    index: 'Nifty FMCG',
    sentiment: 'Bullish',
    entry: '49,800 - 50,100',
    target: '50,700',
    stoploss: '49,300',
    chance: 'High (70%)',
    rationale: 'Stable consumer demand and defensive flows are keeping FMCG stocks supported.',
  },
  {
    index: 'Nifty Pharma',
    sentiment: 'Neutral',
    entry: '20,300 - 20,450',
    target: '20,900',
    stoploss: '19,950',
    chance: 'Moderate (55%)',
    rationale: 'Mixed news on drug approvals and export demand leads to range-bound movement.',
  },
  {
    index: 'Nifty Midcap 100',
    sentiment: 'Bullish',
    entry: '38,500 - 38,800',
    target: '39,900',
    stoploss: '38,000',
    chance: 'Moderate-High (65%)',
    rationale: 'Healthy broad-market participation and momentum in growth names are favorable.',
  },
]
