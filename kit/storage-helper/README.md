# Storage helper

A small service, run as root, that measures every app's folder for the Storage app (`apps/mgu_storage`). On the car
each app runs as a Linux user of its own and its folder `/var/opt/public/oap/oap_<uid>` is 750, so an app can only
measure itself; this measures all of them and writes `/run/mgu-storage/apps.json` (readable by every app).

- Which app a folder is: `oap_12201/security/uids.txt` (`<uid>=<app id>`). Custom: listed in
  `oap_12201/data/custom_apps.json` (the kit's installer and the MGU Store list theirs there); `oap_12201` is the app
  platform (MainApp); every other one is BMW's own.
- Also the custom tools' folders in `/var/opt` (`mgu-*`, `idrive7*`, `cluster-render`, ...).
- Sizes with `du -sk` (a walk adding allocated blocks where du fails).
- At start, every 30 minutes, and within 5 s of the Storage app's Refresh (it creates `/dev/shm/mgu-storage-request`).
- Reads only; writes nothing but `/run/mgu-storage/apps.json`. `Nice=19`, idle disk priority.

Installed from the MGU Store as the tool "Storage helper" (`component.json`). Without it, Storage shows only its own
folder's size and "no access" for the others.

Test: `node kit/tools/test_mgu_storage.js`.
