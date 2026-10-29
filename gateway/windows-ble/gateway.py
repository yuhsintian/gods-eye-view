"""Windows BLE Gateway. Physical Windows BLE validation is still pending."""

import argparse
import asyncio
import json
import logging
import sys

if sys.version_info < (3, 11):
    raise SystemExit(
        "ULD BLE Gateway requires Python 3.11+ (asyncio TaskGroup/timeout)"
    )

from config import load_config
from parser import Advertisement, build_observation
from scanner import scan

LOG = logging.getLogger("uld.gateway")


async def run_scan_only(stop_event, scanner_runner=scan, emit=print):
    def detected(device, data):
        emit(
            json.dumps(
                Advertisement.from_bleak(device, data).diagnostic(), ensure_ascii=False
            )
        )

    LOG.info(
        "SCAN ONLY: raw advertisements; no HTTP requests, no assumed nRF format. Ctrl+C to stop."
    )
    await scanner_runner(detected, stop_event)


async def run_gateway(config, stop_event, scanner_runner=scan, client_factory=None):
    import httpx
    from transport import ObservationPublisher

    if client_factory is None:
        client_factory = lambda: httpx.AsyncClient(
            timeout=config.http_timeout_seconds, trust_env=False
        )
    async with client_factory() as client:
        publisher = ObservationPublisher(config, client)

        def detected(device, data):
            try:
                observation = build_observation(
                    Advertisement.from_bleak(device, data), config
                )
                if observation is not None:
                    publisher.offer(observation)
            except ValueError as error:
                LOG.warning("Advertisement ignored: %s", error)

        LOG.info(
            "Gateway reader=%s backend=%s tags=%d interval=%dms; sightings only, no location/movement inference",
            config.gateway_id,
            config.backend_url,
            len(config.tags),
            config.publish_interval_ms,
        )
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(publisher.run(stop_event))
            tasks.create_task(scanner_runner(detected, stop_event))


def main(argv=None):
    args_parser = argparse.ArgumentParser(
        description="ULD EYE BLE sighting gateway (PENDING PHYSICAL WINDOWS TEST)"
    )
    mode = args_parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--scan-only",
        action="store_true",
        help="Print actual raw advertisements; never POST",
    )
    mode.add_argument(
        "--config", help="Validated JSON tag matching and Backend settings"
    )
    args_parser.add_argument(
        "--log-level", choices=("DEBUG", "INFO", "WARNING", "ERROR"), default="INFO"
    )
    args = args_parser.parse_args(argv)
    logging.basicConfig(
        level=args.log_level, format="%(asctime)s %(levelname)s %(message)s"
    )
    try:
        config = None if args.scan_only else load_config(args.config)

        async def run():
            stop = asyncio.Event()
            if args.scan_only:
                await run_scan_only(stop)
            else:
                await run_gateway(config, stop)

        asyncio.run(run())
    except KeyboardInterrupt:
        LOG.info("Ctrl+C: scanner and HTTP client shut down")
    except Exception as error:
        LOG.error(
            "Gateway stopped: %s",
            error,
            exc_info=args.log_level == "DEBUG" or isinstance(error, ExceptionGroup),
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
