import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { parseRetryAfterMs } from "~/lib/error"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()

  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  let sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  while (true) {
    const response = await fetch(accessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) {
      // A 429 here overrides our interval with the server's requested wait,
      // same reasoning as the Copilot token refresh loop.
      const retryAfterMs = parseRetryAfterMs(response.headers)
      if (retryAfterMs !== null) {
        sleepDuration = Math.max(sleepDuration, retryAfterMs)
      }
      await sleep(sleepDuration)
      consola.error("Failed to poll access token:", await response.text())

      continue
    }

    const json = await response.json()
    consola.debug("Polling access token response received")

    const { access_token, error } = json as AccessTokenResponse

    if (access_token) {
      return access_token
    }

    // GitHub's device flow returns HTTP 200 with an error body for
    // in-progress states. "slow_down" means we're polling too fast --
    // GitHub's spec requires increasing the interval by 5s and keeping it
    // increased for all subsequent requests.
    if (error === "slow_down") {
      sleepDuration += 5000
      consola.debug(
        `Received slow_down, increasing poll interval to ${sleepDuration}ms`,
      )
    }

    await sleep(sleepDuration)
  }
}

interface AccessTokenResponse {
  access_token?: string
  token_type: string
  scope: string
  error?: string
}
