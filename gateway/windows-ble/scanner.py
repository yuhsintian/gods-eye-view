"""Bleak lifetime owner. Importing this module never touches the BLE adapter."""


async def scan(callback, stop_event, scanner_factory=None):
    if scanner_factory is None:
        from bleak import BleakScanner

        scanner_factory = BleakScanner
    async with scanner_factory(detection_callback=callback):
        await stop_event.wait()
