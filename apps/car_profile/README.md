# Car profile

One place for the car's engine values and units. Set them here once and the other apps follow them.

| Setting | Followed by |
|---|---|
| Engine (Auto / Diesel / Petrol) | M Vitals, Redline, Warm-Up, Virtual Dyno |
| Redline | M Vitals, Redline, Warm-Up, AK Cluster |
| Shift point before redline | Redline, AK Cluster |
| Rev scale up to | M Vitals, Redline, Virtual Dyno (*Graph up to*), AK Cluster |
| Cold rev limit | Redline, Warm-Up, AK Cluster |
| Shift lights (shift point / rev bar) | Redline |
| Rev bar from | Redline, AK Cluster Centre (*Shift light: starts at*) |
| Cold-engine rev guard (On / Off) | Redline, AK Cluster |
| Oil is warm at | Redline, Warm-Up, AK Cluster |
| Coolant is warm at | Warm-Up |
| Speed unit | M Vitals, Redline, Drag Timer, Brake Test, G-Force, AK Cluster |
| Distance unit | Brake Test (km -> metres, miles -> feet), eDrive |
| Temperature unit | M Vitals, Redline HUD, Warm-Up, eDrive, Transmission Config, AK Cluster |
| Pressure unit | M Vitals, Redline HUD (boost and tyres), AK Cluster |
| Fuel use unit | Redline HUD |
| Torque unit, Power unit | M Vitals, Redline HUD, Virtual Dyno, AK Cluster |

Every setting starts at **Each app**: until it is set here, each app keeps its own setting, so installing the app
changes nothing. A setting the profile sets shows the profile's value in the other app's Settings and can't be changed
there (no arrow on its row); set it back to *Each app* here and the app's own value is back.

## How it works

- The app runs from the head unit's start (`autostart`) and writes what is set to `/dev/shm/car-profile.json`
  (`profile.js`), again whenever a setting changes. The apps run as users of their own and can't read each other's
  data folders; `/dev/shm` is readable by all of them, and is emptied at every start of the head unit, which is why
  the app writes it again each time from its own saved settings. It doesn't have to be opened.
- In the other apps, the kit's settings (`kit/runtime/mgu.js` `Settings`) follow it for every setting with
  `"profile": "<name>"` in their `app.json` (`"profileMap"` where the two name a value differently). They look at the
  file every 3 s; a change reaches the app as a change of the setting would (the gauges' scale, the redline, the units
  redraw at once).
- A value an app can't take, a name the profile leaves to each app, a file in another format (`"v"` other than 1), or
  no file at all: the app uses its own setting. Uninstalling Car profile gives every app its own settings back at the
  next start of the head unit (at once if everything is set back to *Each app* first). No app requires it.

File format:

```json
{ "v": 1, "app": "car_profile", "version": "1.0.0",
  "values": { "redline": 6000, "rpmScale": 7000, "torqueUnit": "kgm", "speedUnit": "kmh" } }
```

Other apps can read the same file: only the values set are in it; unknown names are to be ignored. **AK Cluster**
(akakingj/idrive7-cluster-info: Cluster Layouts, Centre and Info) does: its red zone and shift point, its cold-engine
guard and its units follow it the same way. Its shift point is worked out as Redline's fixed one (the redline less
*Shift point before redline*, lowered while the oil is cold from the cold rev limit at 30 °C to normal at *Oil is warm
at*); Redline's learned per-gear shift point is Redline's own. The profile's *Auto* (0) for the redline, the rev scale
and the cold rev limit is left to each cluster app's own setting (they have no Auto).

Tests: `node kit/tools/test_car_profile.js`.
