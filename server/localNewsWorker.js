const workerData = JSON.parse(process.env.NEWS_WORKER_CONFIG)
import { pipeline, env } from '@huggingface/transformers'

env.cacheDir = workerData.cacheDir
env.localModelPath = `${workerData.cacheDir}/`
env.allowRemoteModels = Boolean(workerData.download)
const classifier = await pipeline('text-classification', 'Xenova/finbert', {
  dtype: 'q8', device: 'cpu', local_files_only: !workerData.download,
})
process.send({ ready: true })
process.on('message', async ({ id, articles }) => {
  try {
    const results = []
    for (const article of articles.slice(0, 32)) {
      const prediction = await classifier(`${article.title} ${article.description || ''}`.slice(0, 1200), { truncation: true, max_length: 512 })
      const item = prediction[0], label = String(item?.label).toUpperCase()
      results.push({ articleId: article.id, sentiment: ['POSITIVE', 'NEGATIVE', 'NEUTRAL'].includes(label) && item.score >= .7 ? label : 'UNCLEAR',
        source: 'LOCAL_FINBERT', scope: 'TEXT_ONLY', reason: 'Local financial-text sentiment; Indian-market impact is unverified and excluded from the news evidence score.' })
    }
    process.send({ id, results })
  } catch { process.send({ id, error: 'Local text classification is unavailable.' }) }
})

process.on('disconnect', () => process.exit(0))
