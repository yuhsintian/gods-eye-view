"""Bounded latest-per-tag coalescing, throttled HTTP and capped retry backoff."""

import asyncio
import logging
import time
import httpx

LOG = logging.getLogger("uld.gateway")


class ObservationPublisher:
    def __init__(self, config, client, clock=time.monotonic):
        self.config, self.client, self.clock = config, client, clock
        self.pending = {}
        self.allowed_tags = {tag.tag_id for tag in config.tags}
        self.next_tag_attempt = {}
        self.failures = 0
        self.next_retry = 0

    def offer(self, observation):
        if observation["tagId"] not in self.allowed_tags:
            return False
        self.pending[observation["tagId"]] = dict(observation)
        return True

    async def flush_due(self):
        if self.clock() < self.next_retry:
            return
        for tag_id in list(self.pending):
            now = self.clock()
            if now < self.next_tag_attempt.get(tag_id, 0):
                continue
            observation = self.pending[tag_id]
            self.next_tag_attempt[tag_id] = now + self.config.publish_interval_ms / 1000
            permanent = False
            try:
                async with asyncio.timeout(self.config.http_timeout_seconds):
                    response = await self.client.post(
                        self.config.backend_url + "/api/uld/observations",
                        json=observation,
                    )
                    response.raise_for_status()
                    result = response.json()
                    if (
                        not isinstance(result, dict)
                        or result.get("accepted") is not True
                    ):
                        raise ValueError("Backend did not acknowledge the Observation")
                if not result.get("mapped", True):
                    LOG.warning(
                        "Accepted unmapped tag=%s; check Backend Tag Registry", tag_id
                    )
                else:
                    LOG.info(
                        "POST accepted observation=%s tag=%s uld=%s updated=%s duplicate=%s stream=%s",
                        observation["observationId"],
                        tag_id,
                        result.get("uldId"),
                        result.get("updated"),
                        result.get("duplicate", False),
                        result.get("streamRevision"),
                    )
            except (httpx.HTTPError, TimeoutError, ValueError) as error:
                if isinstance(error, httpx.HTTPStatusError):
                    permanent = (
                        400 <= error.response.status_code < 500
                        and error.response.status_code not in (408, 429)
                    )
                if permanent:
                    LOG.error(
                        "Dropping rejected observation=%s: %s",
                        observation["observationId"],
                        error,
                    )
                else:
                    self.failures += 1
                    delay = (
                        min(
                            self.config.retry_max_ms,
                            self.config.retry_initial_ms
                            * 2 ** min(self.failures - 1, 16),
                        )
                        / 1000
                    )
                    self.next_retry = self.clock() + delay
                    LOG.warning(
                        "Backend unavailable (%s); retry in %.1fs; pending=%d (latest/tag only)",
                        error,
                        delay,
                        len(self.pending),
                    )
                    return
            # A newer advertisement may have arrived while this POST awaited.
            # Keep it. Otherwise retries reuse the exact same observationId.
            if self.pending.get(tag_id) is observation:
                del self.pending[tag_id]
            self.failures = 0
            self.next_retry = 0

    async def run(self, stop_event):
        try:
            while not stop_event.is_set():
                await self.flush_due()
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=0.1)
                except TimeoutError:
                    pass
        finally:
            LOG.info(
                "Publisher stopped; discarded %d pending observations",
                len(self.pending),
            )
            self.pending.clear()
