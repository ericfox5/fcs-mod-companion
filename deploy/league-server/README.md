# League server on a cloud VM

This folder puts the Online Dynasty league server on a small Linux server on the internet.
Members then connect to `play.fcs-mod.online` instead of your PC.

You do this once. It takes about 20 minutes.

## What you need

- An account with a cloud provider (Hetzner, DigitalOcean, Vultr, Linode, any of them).
- Access to the DNS settings for `fcs-mod.online` (Cloudflare).
- The bridge token. It is the `token` value in `C:\Users\<you>\.ncaa-bridge\config.json` on your PC.
  Treat it like a password. Do not paste it into chat, email or a commit.
- A registry token. This is a second, weaker secret that you make yourself. See "The two tokens" below.
  You can skip it on day one. The setup script then uses the bridge token in its place and tells you so.
- The website already deployed with the member sign-up pages. The server reads its player list from the site.

### The two tokens

The server talks to the website with two secrets. Each goes to one service only.

| Secret | What it can do | Who gets it |
|---|---|---|
| Bridge token | Read and **write** league data on the site. | The site sync. It listens on no port. |
| Registry token | Read the member list. Nothing else. | The game service. It faces the internet. |

Why two: the game service is the part strangers can reach. If someone ever broke into it, they would find only the registry token. That token cannot change anything on the site.

Make the registry token once, on your PC:

```bash
openssl rand -base64 32
```

Copy what it prints. Give it to the site as the secret named `REGISTRY_TOKEN` (from the `worker` folder: `npx wrangler secret put REGISTRY_TOKEN`, then paste). Use the same value when the setup script asks for the registry token.

**Web-simulated games (Supersim) and website stories in the in-game Dynasty Wire.** The game service delivers these, and it needs the bridge token to do it. With the setup above they are off on the cloud server. Everything else works, including the in-game Dynasty Wire itself (members' own stories and photos inside the game). To turn them on, add the bridge token to `/etc/fcs-league/registry.env` (the file explains how). That puts the full token back into the service that faces the internet. It is your call. See "Things to decide".

## Step 1. Create the server

1. Create a VM with **Ubuntu 26.04 LTS** (24.04 LTS also works).
2. Size: the smallest plan with **2 GB of memory** is enough. 1 CPU is fine. 20 GB of disk or more.
3. It needs a public **IPv4** address. Write it down. Example: `203.0.113.7`.
4. Add your SSH key when the provider asks. Do not use password logins.
5. If the provider has its own firewall ("security group", "cloud firewall"), allow these coming in:

   | Port | Type | What it is |
   |---|---|---|
   | 22 | TCP | SSH, for you |
   | 42127 | TCP | Redirector. The first thing a console asks. |
   | 33152 | TCP | Blaze. Logins and dynasties. |
   | 17503 | TCP | Locker. Dynasty and team files. |
   | 17502 | TCP and UDP | QoS. Connection checks. |
   | 17500, 17501 | UDP | QoS firewall checks. |
   | 53 | UDP | Name service for real PS3 consoles (see "Real consoles" below). Not needed for RPCS3 members. |

   And port 17504 TCP for the in-game Dynasty Wire (on by default). Nothing else.

## Step 2. Point the name at the server

1. Open Cloudflare, then the DNS page for `fcs-mod.online`.
2. Add a record: type **A**, name **play**, content **your server's IPv4 address**.
3. Set proxy status to **DNS only** (the grey cloud). This matters.
   Cloudflare's proxy only passes web traffic. The game does not speak web traffic on these ports.
4. Do not add an AAAA (IPv6) record. The game uses IPv4.
5. Save. Check it from your PC:

   ```powershell
   nslookup play.fcs-mod.online
   ```

   It must show your server's address.

## Step 3. Make the app archive (on your PC)

Commit your work first. The archive holds the last commit, not unsaved edits.

Open Git Bash in the project folder:

```bash
bash deploy/league-server/make-tarball.sh
```

It writes `fcs-league.tar.gz` next to the project folder. It contains the code only.
No league data, no token.
If your PC has the redirector certificate (`spike/blaze/server/certs`), it is included, so the server uses the same one your game already accepts.

## Step 4. Copy it to the server

```bash
scp ../fcs-league.tar.gz root@play.fcs-mod.online:/root/
```

(Use `ubuntu@...` if your provider gives you an `ubuntu` user instead of `root`.)

## Step 5. Run the setup script (on the server)

Log in:

```bash
ssh root@play.fcs-mod.online
```

Then:

```bash
mkdir -p fcs && tar -xzf fcs-league.tar.gz -C fcs
sudo bash fcs/deploy/league-server/provision.sh \
  --tarball fcs-league.tar.gz \
  --public-host play.fcs-mod.online \
  --site https://fcs-mod.online
```

The script asks for the bridge token. Paste it and press Enter. It is not shown on screen.
Then it asks for the registry token. Paste it, or press Enter alone to use the bridge token for now.
Each is saved in its own file that only the server's administrator can read.

The script then:

- installs Node.js,
- creates four locked-down users, one for each service (`fcs-blaze`, `fcs-redirector`, `fcs-qos`, `fcs-sync`). None is an administrator. One service cannot read another's secrets,
- installs the app in `/opt/fcs-league/app`,
- turns on the firewall with only the ports above,
- starts four services and a daily backup.

At the end it prints a status list.

## Step 6. Check that it works

On the server:

```bash
sudo bash /opt/fcs-league/app/deploy/league-server/check.sh
```

Every line should say `ok`. The "Registry" line should say the registry was updated from the site.

Look at the "Mode" lines. They must say each service **started in cloud mode**.
Cloud mode is what makes the server check every player against the member list.
If a line says `LOCAL mode`, stop and fix `NCAA_CLOUD` in `/etc/fcs-league/league.env` before you tell anyone the address.

From your PC (PowerShell), check that the ports answer from outside:

```powershell
foreach ($p in 42127, 33152, 17503, 17502) { Test-NetConnection play.fcs-mod.online -Port $p | Select-Object RemotePort, TcpTestSucceeded }
```

All four must say `True`. If one says `False`, look at the provider's firewall (step 1.5).

Then do the real test: run the member wizard (`FCS-online.exe`, "Join the online league") with a test account and start Online Dynasty.

## Everyday things

**See what the server is doing**

```bash
journalctl -u 'fcs-league-*' -f
```

Press Ctrl+C to stop watching. Logs never contain the token, player credentials or dynasty passwords.

**Restart everything**

```bash
sudo systemctl restart fcs-league.target
```

Connected players are dropped and reconnect.

**Change a setting**

```bash
sudo nano /etc/fcs-league/league.env
sudo systemctl restart fcs-league.target
```

Every setting is explained inside that file.

Write a value and nothing after it. `NCAA_CLOUD=1 # public` is wrong: the note becomes part of the value.
On/off settings take `on`, `1`, `true`, `yes`, or `off`, `0`, `false`, `no`.
Anything else stops the server. The log says `cannot start` and names the setting. It never guesses.

**Change a token**

```bash
sudo nano /etc/fcs-league/bridge.env      # the bridge token (site sync)
sudo systemctl restart fcs-league-sync

sudo nano /etc/fcs-league/registry.env    # the registry token (game service)
sudo systemctl restart fcs-league-blaze
```

**Update to a new version**

Repeat steps 3, 4 and 5. You can leave out `--public-host` and `--site` the second time.
Your settings, token and league data are kept. The previous version stays in `/opt/fcs-league/app.old`.

**Remove a player**

Disable them on the website. The server picks it up within a minute.
If they are connected, they are disconnected. They cannot log in again.

**If the website is down**

The server keeps the last player list it got and keeps running.
New sign-ups and removals wait until the site is back.

An old list has a risk: someone you disabled on the site can still sign in with it. So the server watches the list's age.

- After 6 hours without the site, the log has a `WARNING` line once an hour. `check.sh` shows it.
- After 72 hours, nobody **new** can sign in. Players who are already signed in keep playing.
- When the site answers again, sign-ins start again by themselves.

Both times are settings in `league.env` (`NCAA_REGISTRY_WARN_HOURS`, `NCAA_REGISTRY_MAX_AGE_HOURS`). `0` turns one off.

**If a service stops**

It starts again by itself. This is true for a crash, for running out of its memory allowance, and for a settings mistake.
The first restart is after 5 seconds. If it keeps stopping, the pause grows to one minute and stays there.

There is no limit on the number of restarts. An earlier version gave up after ten tries in five minutes. The service then stayed down until someone logged in and started it by hand. That could take the league offline overnight for a problem that had already passed.

A settings mistake cannot fix itself. The service is then tried once a minute and the log shows one `cannot start` line each time. `check.sh` reports it as NOT running. Fix the setting and it comes up at the next try.

`sudo systemctl stop fcs-league.target` still stops everything, and it stays stopped.

## Backups

A backup runs every day. Files are in `/var/backups/fcs-league`. The newest 14 are kept.

A backup holds the dynasties, the uploaded save files and the settings. It does not hold the token.

The backups are on the same server. If the server is lost, so are they.
Turn on the off-site copy (next section), or copy one to your PC now and then:

```bash
scp root@play.fcs-mod.online:/var/backups/fcs-league/fcs-league-*.tar.gz .
```

A backup is not made if the disk is nearly full. `check.sh` tells you when the newest backup is too old.

Make a backup right now:

```bash
sudo /opt/fcs-league/app/deploy/league-server/backup.sh
```

Put a backup back:

```bash
sudo bash /opt/fcs-league/app/deploy/league-server/restore.sh /var/backups/fcs-league/fcs-league-20261115T091500Z.tar.gz
```

The data from before the restore is kept beside it, so a wrong restore can be undone.

## Off-site backups (optional, off by default)

This sends each daily backup to storage outside the server. A Cloudflare R2 bucket works. So does any S3-compatible storage.

The backup is locked with a passphrase **before** it leaves the server. The storage only ever holds the locked file.
Nobody can open it without the passphrase. That includes you.

### Turn it on

1. In Cloudflare, open **R2** and create a bucket. Name it `fcs-league-backups`.
   Use a new bucket. Do not use the website's bucket.
2. In R2, open **Manage API tokens** and create a token.
   Permission: **Object Read & Write**. Limit it to that one bucket.
   Cloudflare shows an **Access Key ID** and a **Secret Access Key** once. Keep the page open.
3. On the bucket's **Settings** page, find the **S3 API** address.
   You need the part before the bucket name. It looks like `https://<account id>.r2.cloudflarestorage.com`.
4. On the server, install the upload tool and make a passphrase:

   ```bash
   sudo apt-get install -y rclone
   openssl rand -base64 32
   ```

   The second command prints a passphrase. **Save it in your password manager now.**
   If the server is lost and you do not have the passphrase, the backups are gone for good.
5. Create the settings file. Only the administrator can read it:

   ```bash
   sudo install -m 600 -o root -g root /opt/fcs-league/app/deploy/league-server/offsite.env.example /etc/fcs-league/offsite.env
   sudo nano /etc/fcs-league/offsite.env
   ```

   Fill in the address, the bucket, the two keys and the passphrase. Set `FCS_OFFSITE=on`. Save.
6. Test it:

   ```bash
   sudo /opt/fcs-league/app/deploy/league-server/backup.sh --offsite-check
   ```

   It uploads a small test file, downloads it, and opens it. It must say `off-site check passed`.

From now on every daily backup is also uploaded. Copies older than 30 days are deleted from the bucket.
`check.sh` shows when the last upload happened.

To turn it off again, set `FCS_OFFSITE=off` in that file.

### Get a backup back from off-site storage

On the server:

```bash
sudo /opt/fcs-league/app/deploy/league-server/backup.sh --offsite-list
sudo /opt/fcs-league/app/deploy/league-server/backup.sh --offsite-fetch latest
```

The second command downloads the newest backup and opens it with the passphrase from the settings file.
Use a name from the list instead of `latest` to get an older one.
It prints the restore command. Run it:

```bash
sudo bash /opt/fcs-league/app/deploy/league-server/restore.sh /var/backups/fcs-league/restored/fcs-league-20261115T091500Z.tar.gz
```

If the old server is gone: set up a new one first (steps 1 to 5 at the top, then "Turn it on" steps 4 and 5 with the **same** passphrase). Then run the commands above.

Without any server: download the `.gpg` file from the R2 page in Cloudflare. Open it on a PC that has `gpg`:

```bash
gpg --decrypt --output fcs-league-backup.tar.gz fcs-league-20261115T091500Z.tar.gz.gpg
```

It asks for the passphrase. The result is a normal backup file for `restore.sh`.

### What to know

- The passphrase and the storage keys are in `/etc/fcs-league/offsite.env`. That file is never in a backup.
- If you change the passphrase, older uploads still need the old one. Keep both.
- An upload that fails does not stop the server or the local backup. See `journalctl -u fcs-league-offsite -n 30`.

## Storage limits

Members upload their dynasty to the server. Limits keep one person, or everybody together, from filling the disk.

- Each table, each dynasty and each member has a cap.
- All league data together has a budget. The default is 2 GB, room for about 35 dynasties.
- When a cap is reached, that upload is refused. The game shows an error. Nothing already saved is lost.
- The log then has a line that starts with `REFUSED (storage limit)`. It names the limit and the setting.
- When the whole budget is used up, the log says `STORAGE FULL`. No new uploads are taken until you free space or raise the budget.
- At 80% the log has a `WARNING` line, so you see it coming.
- A commissioner who deletes a dynasty frees its tables at once. The daily backup still has them.

The settings are in `league.env` under "storage limits". The defaults are several times what a normal dynasty needs.
Do not raise the budget without a bigger disk. The 14 daily backups share the disk with the data.

## If a data file is damaged

The server writes each data file in one step. A crash or a power cut cannot leave half a file.
It also keeps the previous version of its main files next to them, with `.bak` on the end.

If a file is damaged anyway, the server loads the `.bak` copy when it starts.
The log then says `WARNING ... Loaded the previous good copy`. `check.sh` shows it for a day.
At most the last change before the damage is lost. The damaged file is kept with `.damaged` on the end.

If both copies are damaged, the server does not start. The log says `cannot start` and names the file.
Restore the newest backup (see "Backups"). The server never starts an empty league over your data.

## Dynasty rules the server enforces

- **Saving locks a dynasty for a moment.** While one console sends its data, the others wait. If that console stops halfway, the lock is dropped after 5 minutes without activity (`NCAA_UPDATE_LOCK_SECONDS`). It is also dropped when that player disconnects, leaves, or is removed. A restart of the server clears every lock.
- **The commissioner goes first.** A commissioner's save replaces a member's unfinished one. A commissioner can also clear a stuck lock from the game (Break Lock).
- **When the commissioner leaves**, the member who has been in the dynasty longest becomes commissioner.
- **When the last member leaves**, the dynasty is deleted. Its tables are freed like a deleted dynasty's. The daily backup still has it.
- **A removed member stays removed.** They cannot rejoin, even if the dynasty is public. The commissioner lets them back in by inviting them by name in the game.
- **A full dynasty takes no more members.** The limit is the number of users the commissioner chose when creating it.
- **Dynasties per player.** The limit (`NCAA_MAX_DYNASTIES_PER_USER`, default 10) counts dynasties a player **created** that still exist. Handing one over and leaving does not free a slot. Deleting it does.
- **Dynasties from an older server that have no members** are kept on disk but are not listed and cannot be joined.

## Dynasty passwords

A commissioner can put a password on a dynasty. The server does not keep the password itself.
It keeps a scrambled form (a salted hash). Nobody can read a password out of the files, the logs or a backup.

A dynasty with a password shows up in the search list, but nothing else about it is given out. Its status and its files go only to members and to someone who has typed the password.

A forgotten password cannot be looked up. Members who are already in the dynasty are not affected.
To remove a password: stop the server, open `dynasties.json`, find that dynasty's `passwordHash` and change its value to `""` (two quote marks, nothing between). Start the server.

## Moving the league that is on your PC today (optional)

Only do this if you want the existing dynasties on the new server. Read "Things to decide" first.

1. Stop the league on your PC (`stop-league.cmd`). Leave it stopped.
2. In Git Bash: `bash deploy/league-server/make-tarball.sh --state`
3. Copy `fcs-league-state.tar.gz` to the server with `scp`.
4. On the server: `sudo bash /opt/fcs-league/app/deploy/league-server/restore.sh fcs-league-state.tar.gz`

## If something is wrong

| What you see | What to do |
|---|---|
| A service is "NOT running" | `journalctl -u fcs-league-blaze -n 50` (or `-redirector`, `-qos`, `-sync`). The last lines say why. |
| "cannot start: ..." in the log | A setting is wrong. The message names it. Fix `/etc/fcs-league/league.env`. The service tries again within a minute. |
| "cannot start: NCAA_... must be on or off" | That setting has something other than on or off. Often a note typed after the value. Remove it. |
| "cannot start: refusing to listen on ..." | Cloud mode is off, so the server will not open a public address. Set `NCAA_CLOUD=1` exactly. |
| `check.sh` says a service is in LOCAL mode | Same cause. Fix `NCAA_CLOUD`, then `sudo systemctl restart fcs-league.target`. |
| "registry sync failed (site answered 401)" | The registry token is wrong. Fix `/etc/fcs-league/registry.env`. It must match `REGISTRY_TOKEN` on the site (or be the bridge token). |
| "WARNING: the member list has not been confirmed" | The site has not answered for hours. Check the site. Players can still sign in. |
| "NEW SIGN-INS ARE STOPPED" | The site has not answered for 3 days. Nobody new can sign in until it does. See "If the website is down". |
| "update lock ... cleared" in the log | Normal. A save was started and not finished, and the server released it. |
| "REFUSED (oversized upload)" in the log | Someone uploaded a file that is not a real team file. It was not used. Look at who it was. |
| "(N similar line(s) not shown)" in the log | One address caused many refusals. The server writes ten such lines a minute per address and counts the rest. |
| "registry sync failed (site answered 404)" | The website does not have the member list yet. Deploy the site. |
| "registry response rejected" | The site sent a player list the server will not trust. Nobody new can log in. Send the log line to whoever maintains the site. |
| Ports answer on the server but not from your PC | The provider's firewall is closed (step 1.5), or the DNS record is proxied (step 2.3). |
| Game says the EA servers are unavailable | Run `check.sh`. Then run the member wizard again; it tests each port. |
| "REFUSED (storage limit)" in the log | One upload was over a limit. The line names the setting. Normal play stays far below the defaults, so look at who it was first. |
| "STORAGE FULL" in the log | The league's data budget is used up. Delete dynasties nobody plays, or raise `NCAA_STATE_BUDGET_MB` (bigger disk first). |
| "Loaded the previous good copy" in the log | A data file was damaged and the server used its `.bak` copy. See "If a data file is damaged". |
| "cannot start: ... is damaged" | Both copies of a data file are bad. Restore the newest backup. |
| "backup NOT made" in `journalctl -u fcs-league-backup` | The disk is nearly full. Delete old backups in `/var/backups/fcs-league` or get a bigger disk. |
| Off-site upload fails | `journalctl -u fcs-league-offsite -n 30`. Then `backup.sh --offsite-check`. Usually a wrong key or bucket name. |

## What is where

| Path | What |
|---|---|
| `/opt/fcs-league/app` | The program. Owned by root. The service cannot change it. |
| `/etc/fcs-league/league.env` | Settings. No secrets. |
| `/etc/fcs-league/bridge.env` | The bridge token, for the site sync. Only root can read it. |
| `/etc/fcs-league/registry.env` | The registry token, for the game service. Only root can read it. |
| `/etc/fcs-league/certs` | The redirector's certificate. |
| `/etc/fcs-league/offsite.env` | Off-site backup settings and passphrase. Only root can read it. Only there if you turned it on. |
| `/var/lib/fcs-league/private` | League data: dynasties, save files, the cached player list. Files ending in `.bak` are the previous good copies. The game service writes here. The site sync can read it. |
| `/var/lib/fcs-league/private/web-edits` | Changes made on the website, waiting for consoles. The only part of the data the site sync can write. |
| `/var/lib/fcs-league/sync` | The site sync's own notes on what it has already sent. |
| `/var/backups/fcs-league` | Daily backups. `restored/` holds backups fetched from off-site storage. |

The four services: `fcs-league-redirector`, `fcs-league-blaze`, `fcs-league-qos`, `fcs-league-sync`.
Each runs as its own user: `fcs-redirector`, `fcs-blaze`, `fcs-qos`, `fcs-sync`.
`fcs-league.target` starts and stops them together.
Two more run once a day: `fcs-league-backup`, then `fcs-league-offsite` (it does nothing unless you turned it on).

## How it is protected

- **Only signed-up members get in.** Each member's game carries a private credential. The server checks it against the list from the website. Anything else is refused. There is no fallback.
- **The server will not start without that list configured.** A wrong setting stops it with a clear message instead of running open. That includes a setting it cannot read as on or off. Without the list it listens only to the machine it runs on, never to the internet.
- **Before sign-in, very little is accepted.** A connection that has not signed in may send only the few small messages a console sends first. Anything else is refused without being read. After sign-in each kind of message has its own size limit. Only table uploads may be large.
- **Each service has its own user and its own secret.** The game service holds a token that can only read the member list. The token that can write to the site is given only to the site sync, which no one can connect to.
- **An old member list stops new sign-ins.** If the site has been unreachable for three days, nobody new gets in until it answers. See "If the website is down".
- **A save cannot block a dynasty.** The lock a save takes ends by itself. See "Dynasty rules the server enforces".
- **Removed members are cut off** within one sync (60 seconds), including a session that is open.
- **Each file link is personal.** Upload and download links work only for the member they were made for, and stop when they disconnect. A link takes one upload at a time, and an upload goes straight to disk instead of into memory.
- **Uploaded files are not trusted.** A file that would unpack to far more than a real team or dynasty file is refused instead of unpacked.
- **Deleted files count.** A member's deleted files are kept for 14 days and count toward the same storage limit as their live files. The oldest are removed first when room is needed.
- **Limits.** Connections per address, login attempts per minute, packet size, upload size, storage per member and dynasties per member are all capped. See `league.env`.
- **Storage limits.** Table uploads are capped per table, per dynasty and per member, and all league data has one budget. See "Storage limits".
- **Dynasty passwords** are stored as a salted hash, never as text. Wrong guesses are slowed down.
- **Data files** are written in one step and the previous copy is kept. A crash does not cost you the league.
- **The services are boxed in.** Each runs as a user with no admin rights. The game service can write only the data folder. The site sync can write only its own two folders. The other two can write nothing.
- **The services come back by themselves** after a crash or when one runs out of memory. See "If a service stops".
- **The in-game Dynasty Wire** (when it is on) shows a story or photo in a dynasty only if the member who uploaded it belongs to that dynasty.
- **The firewall** blocks everything except SSH and the game ports.
- **What it does not do:** the game port is not encrypted unless you turn that on (see "Encrypting the game port", off by default and not yet tried with the game). The 2013 game cannot do modern encryption either way. With it off, a member's credential travels as the game sends it. Someone who can watch a member's network traffic could copy it. If that happens, disable the member on the site and issue a new credential.

## Encrypting the game port (optional, off by default)

**What it is.** A console makes two connections. The first, to the redirector (port 42127), has always been encrypted. The second, to the game port (33152), is where the member signs in, and it is not encrypted. So the member's credential crosses the internet as readable text.

`NCAA_BLAZE_TLS=on` changes two things at once:

- the redirector tells the console to encrypt the second connection too;
- the game port accepts only encrypted connections, using the same certificate as the redirector.

**It is off until it has been tried with the game.** Nobody has yet seen the game sign in this way. The server side is tested. Whether the game accepts it is not known. The game may refuse the certificate on the second connection, because the certificate carries the redirector's name and not this server's. The check below settles it.

**What it is worth.** This is the game's own encryption from 2013: SSLv3 with RC4. Both are long retired. It keeps a credential from being read off the wire by a casual observer, such as someone on the same Wi-Fi. It is not modern transport security. Someone with skill and a position between the member and the server could still get past it. Reissuing a credential on the site stays the remedy if one leaks.

**While it is on, every member needs it to work.** There is no mixed mode. If the game does not accept it, nobody can sign in until you turn it off again.

### The check, on your PC first (RPCS3)

Do this on the PC league before touching the cloud server. No member is affected.

1. Stop the league: run `stop-league.cmd`.
2. Open a Command Prompt in `spike\blaze\server` and start it with the setting on:

   ```
   set NCAA_BLAZE_TLS=on
   start-league.cmd
   ```

3. In the league window, look for these two lines:

   ```
   [ssl] SSLv3 redirector listening on ... and told to encrypt that connection (NCAA_BLAZE_TLS on, SECU 1)
   [blaze] blaze stub listening on ... (encrypted: SSLv3, NCAA_BLAZE_TLS on), ...
   ```

4. Start the game in RPCS3 and go into Online Dynasty, as usual.
5. Read the league window.

**It works** if you see these, in this order, and the game reaches the dynasty menu:

```
[blaze] -> getServerInstance response: ...:33152 (encrypted Blaze, SECU 1)
[blaze] encrypted connection from ... (SSLv3 RC4-SHA)
[blaze] ps3Login for YourName (user ..., service ...) over an encrypted connection (SSLv3 RC4-SHA)
```

Then open a dynasty and save once, to see that a long session works too.

**It does not work** if the game says the EA servers are unavailable. The league window says why:

| Line in the league window | What it means |
|---|---|
| `ssl alert from ...: level 2 description 42 (bad_certificate)` or `48 (unknown_ca)` | The game refused the certificate on the game port. |
| `ssl error (...): record processing failed: not an SSLv3 record` | The game ignored the instruction and sent unencrypted data. |
| `ssl error (...): record processing failed: client MAC mismatch ...` or `client Finished does not verify` | The game's encryption and the server's do not agree. |
| `closing ...: no SSL handshake within 30s` | The game connected and then said nothing. |
| No `connection from` line after the `getServerInstance response` line | The game never tried the game port. |

Whatever the result, copy those lines into the project notes. To go back: `stop-league.cmd`, close that Command Prompt, and start the league the normal way.

### Turning it on, on the cloud server

Only after the check above worked on the PC.

1. Let the game service read the certificate key. Today only the redirector may read it.

   ```bash
   sudo systemctl edit fcs-league-blaze
   ```

   Type these two lines in the editor, then save and close:

   ```
   [Service]
   SupplementaryGroups=fcs-redirector
   ```

2. Turn the setting on:

   ```bash
   sudo nano /etc/fcs-league/league.env      # NCAA_BLAZE_TLS=on
   sudo systemctl restart fcs-league-redirector fcs-league-blaze
   ```

   Both services must be restarted. Connected players are dropped and reconnect.

3. Watch the log while a test account signs in:

   ```bash
   journalctl -u fcs-league-blaze -u fcs-league-redirector -f
   ```

   The lines to look for are the same as in the PC check. On the cloud server the log is quieter: you get the `encrypted connection from` and `ps3Login ... over an encrypted connection` lines, and the `ssl alert` or `ssl error` lines when it fails.

If the log says `cannot start: NCAA_BLAZE_TLS is on but the certificate files are not readable`, step 1 is missing.

To turn it off: set `NCAA_BLAZE_TLS=off` and run the same restart command. Members do not have to change anything on their side, either way.

## Things to decide (for Eric)

1. **Existing dynasties.** The dynasties on your PC belong to RPCN user ids. The cloud server only accepts website members, whose ids start at 800000. Moved dynasties would have no owner who can log in until someone maps old ids to new ones. Starting fresh on the cloud server is the simple path.
2. **In-game Dynasty Wire** is on by default. It was tried with the game on 2026-11-16; with it off, the game shows "lost your connection to EA servers" pop-ups while saving. Without the bridge token it is not synced with the website.
3. **Certificate.** If the archive did not include your PC's certificate, the server made a new one the same way. That should work but has not been tried with a console.
4. **Storage limits have not been seen on a console.** When an upload is refused the server answers with the game's "dynasty data is locked" error. What the game shows then has not been checked. Normal play is far below the limits.
5. **Password-protected dynasties have not been tried on a console.** The server no longer sends a dynasty's password back to its members (it cannot: it only keeps a hash). Joining with the password is tested on the server side only.
6. **Disk size.** The default data budget (2 GB) is sized for a 20 GB disk with 14 daily backups. A bigger league needs a bigger disk first, then a bigger `NCAA_STATE_BUDGET_MB`.
7. **Supersim and website-to-game Dynasty Wire sync on the cloud server.** Both are delivered by the game service and both need the full bridge token. Giving the game service only the registry token turns them off there. Choose: leave them off, or add the bridge token to `registry.env` and accept that the service facing the internet holds it. A third way needs a change to the website: a separate, narrow token for Supersim results.
8. **The registry token has to exist on the site.** Until you set `REGISTRY_TOKEN` there, the game service uses the bridge token for the member list. `check.sh` reminds you.
9. **Not yet seen on a console:** what the game shows when a save is refused because someone else is saving; the Break Lock button; a member becoming commissioner after the commissioner leaves; a dynasty being deleted when its last member leaves; a removed member trying to rejoin; joining a full dynasty; and the password prompt for a dynasty with a password. The server side of each is tested.
10. **Inviting a removed member back** uses the game's invite-by-name. If that screen turns out not to work, remove their entry from `removed` in that dynasty in `dynasties.json` (server stopped).

## Real consoles

A member on RPCS3 needs nothing from this section. A real PS3 has no setting that says "send the game's server name
to the league", so the league server answers that question itself: it runs a small name service on UDP port 53
(`fcs-league-dns`). A PS3 member sets the console to ask this server for names:

1. On the PS3: Settings, Network Settings, Internet Connection Settings, Custom.
2. Leave everything as it is until **DNS Setting**, choose **Manual**.
3. Primary DNS: this server's IPv4 address. Secondary DNS: `8.8.8.8` (used only if this server does not answer).
4. Finish and save. The connection test's "PlayStation Network" line does not matter.

What the service does: every name under `ea.com` gets this server's address, so the game reaches the league and
never EA. Any other name is looked up here and one address is passed on, so the rest of the console keeps working.

What it will not do, because a public service that answers small questions with big answers gets abused: it answers
only plain address questions, a reply is never more than 16 bytes longer than the question, and each address gets a
limited number of replies per ten seconds. `NCAA_DNS_FORWARD=off` in `league.env` makes it answer only the `ea.com`
names; `NCAA_DNS=off` closes the port (then also `systemctl disable --now fcs-league-dns`).

The console also needs a game program built for that member (their league identity is inside it); that is still done
by hand, see `docs/online-member-setup.md`.

Check it from any PC: `nslookup gosredirector.ea.com <this server's address>` must print this server's address.
Open UDP 53 in the cloud provider's firewall as well. Not yet seen working from a console.

## Start year and Fang's Recruit Overhaul

Two things the site sync does for a brand-new dynasty at its first preseason, both switched on by hand because they
are settings of the sync, not of the game services. Run the commands as the sync's user (see "Running the bridge by
hand" below).

**Start year.** `od year --default 2026` makes every new dynasty start in 2026 instead of the game's 2013. The
console takes it the next time it loads the dynasty, and only while the dynasty is still in its first preseason.
`od year --did N --year 2026` queues it for one dynasty that was created before the default was set.

**Fang's Recruit Overhaul.** The tool (`RecruitOverhaul.exe`) is a Windows program, so the server runs it through
Wine. One-time setup:

1. `sudo apt-get install -y --no-install-recommends wine64`, and a 2 GB swap file (the tool and an import together
   need more memory than a 2 GB server has to spare).
2. Put `RecruitOverhaul.exe` and `recruit-overhaul.sh` (from this folder) in `/var/lib/fcs-league/sync/overhaul-tool/`,
   owned by `fcs-sync`, mode 0700.
3. Add `"overhaulExe": "/var/lib/fcs-league/sync/overhaul-tool/recruit-overhaul.sh"` to
   `/var/lib/fcs-league/sync/.ncaa-bridge/config.json`. The running sync picks it up by itself.

From then on the sync reshapes the recruiting class of every dynasty when its first preseason file arrives, and the
"Re-generate" button on the site's recruiting page works during the preseason. A run takes about five minutes on a
small server (under a minute on a PC). The script exists because the tool cannot print to a pipe under Wine: it
sends the tool's output to a file and prints that. Wine keeps its files in `/var/lib/fcs-league/sync/wine` (about
1.2 GB). `ncaa-bridge od overhaul` shows what has been reshaped and whether a console has taken it.

**Running the bridge by hand** (one line):

```
sudo systemd-run --quiet --wait --pipe -p User=fcs-sync -p Group=fcs-sync -p SupplementaryGroups=fcsleague -p EnvironmentFile=/etc/fcs-league/league.env -p EnvironmentFile=/etc/fcs-league/bridge.env -p Environment=HOME=/var/lib/fcs-league/sync -p WorkingDirectory=/opt/fcs-league/app /usr/bin/node /opt/fcs-league/app/node_modules/tsx/dist/cli.mjs bridge/src/cli.ts od overhaul
```
