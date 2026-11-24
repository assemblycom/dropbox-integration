import * as Sentry from '@sentry/nextjs'

const FLUSH_TIMEOUT_MS = 2000

type MonitorConfig = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>

type CronMonitorParams<T> = {
  slug: string
  cron: string
  thresholds: Omit<MonitorConfig, 'schedule' | 'timezone'>
  run: () => Promise<T>
}

export const withCronMonitor = async <T>({ slug, cron, thresholds, run }: CronMonitorParams<T>) => {
  try {
    return await Sentry.withMonitor(slug, run, {
      schedule: { type: 'crontab', value: cron },
      timezone: 'UTC',
      ...thresholds,
    })
  } finally {
    // Trigger.dev can freeze the worker as soon as run() returns, stranding the closing check-in.
    await Sentry.flush(FLUSH_TIMEOUT_MS)
  }
}
