# SignalK <> MQTT bridge

SignalK Node server plugin that acts as a bridge between SignalK data and MQTT. Its purpose is similar to the one of the [`signalk-mqtt-gw`](https://github.com/tkurki/signalk-mqtt-gw) plugin, but this one has a different interaction with MQTT, inspired by [Victron's dbus-mqtt module](https://github.com/victronenergy/dbus-mqtt).

Note that this plugin doesn't have an embedded MQTT broker. It connects as a client to an MQTT broker running in the system or remotely.

## Features

- [Keepalive mechanism](#keepalive) to avoid unnecessary load on the MQTT broker
  - With the keepalive, MQTT clients can trigger the plugin to send all SignalK deltas or subscribe to specific paths
- Scoped MQTT topics. All topics are prefixed with `<action>/signalk/<id>/`, with `<id>` being the last section of the SignalK server uuid, e.g. `4881db477e55` from `urn:mrn:signalk:uuid:2bb1928e-3118-415e-b242-4881db477e55`. This is to avoid conflicts when more than one SignalK server is connected to the same MQTT broker. The `<action>` prefix defines the purpose of the topic, defined below.
- [Send SignalK deltas to MQTT](#subscribe-to-signalk-deltas)
- [Request specific SignalK paths from MQTT](#request-signalk-data-from-mqtt)
- [Push deltas to SignalK from MQTT](#send-deltas-to-signalk-via-mqtt)
- [Send PUT requests to SignalK from MQTT](#send-put-requests-to-signalk-via-mqtt)

## Keepalive

## Subscribe to SignalK deltas

## Request SignalK data from MQTT

## Send deltas to SignalK via MQTT

## Send PUT requests to SignalK via MQTT
