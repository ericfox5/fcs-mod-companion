"""Packs a roster scrape's player photos for the companion site.

The scrape folder (FCS/Rosters/<year>) holds photos/player_photos_manifest.csv + photos/player_photos/ (the raw
downloads: webp/png/jpg, up to 1 MB each), normalized/players.csv (every scraped player with the game's team id and
the name as written into the game) and assign/assignments.csv (which roster row, by tgid + pgid, each player went
into). This script writes a site package the bridge can use as a photo set (see bridge/src/photos.ts):

    <out>/player_photos/<prefix><stem>.jpg      160 px wide JPEGs (the site shows 28x34 and 80x96 headshots)
    <out>/player_photos_manifest.csv            status, filename, full_name, team_name, tgid, game_first, game_last, pgid, ...

Every row carries the game's team id and in-game name, so the bridge matches a 2026-roster dynasty's players exactly,
and the team_name + full_name columns keep the old team-name match as a fallback.

usage: python -I tools/photo-pack.py --scrape <dir> --out <dir> [--prefix 2026__] [--width 160] [--quality 82] [--jobs 8]
Re-runs skip images whose JPEG already exists and is newer than the source.
"""
import argparse, csv, os, sys, time
from concurrent.futures import ProcessPoolExecutor

def norm(s):
    return ''.join(c for c in (s or '').lower() if c.isalnum())

def convert(args):
    src, dst, width, quality = args
    from PIL import Image, ImageOps
    try:
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            return dst, 'kept', None
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
                bg = Image.new('RGB', im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[-1]); im = bg
            elif im.mode != 'RGB':
                im = im.convert('RGB')
            if im.width > width:
                im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
            im.save(dst, 'JPEG', quality=quality, optimize=True)
        return dst, 'written', None
    except Exception as e:  # a broken download must not stop the pack
        return dst, 'failed', f'{type(e).__name__}: {e}'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scrape', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--prefix', default=''); ap.add_argument('--width', type=int, default=160)
    ap.add_argument('--quality', type=int, default=82); ap.add_argument('--jobs', type=int, default=8)
    a = ap.parse_args()
    man_path = os.path.join(a.scrape, 'photos', 'player_photos_manifest.csv')
    src_dir = os.path.join(a.scrape, 'photos', 'player_photos')
    out_dir = os.path.join(a.out, 'player_photos'); os.makedirs(out_dir, exist_ok=True)

    players = list(csv.DictReader(open(os.path.join(a.scrape, 'normalized', 'players.csv'), encoding='utf-8-sig')))
    by_team_name = {}
    for p in players:
        by_team_name.setdefault((norm(p['team']), norm(p['full_name'])), p)
    assigned = {}
    asg_path = os.path.join(a.scrape, 'assign', 'assignments.csv')
    if os.path.exists(asg_path):
        for r in csv.DictReader(open(asg_path, encoding='utf-8-sig')):
            if r.get('player_id'): assigned[r['player_id']] = r
    rows = list(csv.DictReader(open(man_path, encoding='utf-8-sig')))
    jobs, out_rows, stats = [], [], {'rows': 0, 'no_file': 0, 'no_player': 0, 'assigned': 0}
    for r in rows:
        if r['status'] != 'downloaded' or not r['filename']: continue
        src = os.path.join(src_dir, r['filename'])
        if not os.path.exists(src): stats['no_file'] += 1; continue
        stats['rows'] += 1
        p = by_team_name.get((norm(r['team_name']), norm(r['full_name'])))
        tgid, first, last, pgid = '', '', '', ''
        if p:
            tgid, first, last = p['tgid'], p['game_first'], p['game_last']
            g = assigned.get(p['id'])
            if g: first, last, pgid = g['new_first'] or first, g['new_last'] or last, g['pgid']; stats['assigned'] += 1
        else:
            stats['no_player'] += 1
        stem = os.path.splitext(r['filename'])[0]
        dst_name = f"{a.prefix}{stem}.jpg"
        jobs.append((src, os.path.join(out_dir, dst_name), a.width, a.quality))
        out_rows.append({'status': 'downloaded', 'filename': dst_name, 'full_name': r['full_name'], 'team_name': r['team_name'],
                         'tgid': tgid, 'game_first': first, 'game_last': last, 'pgid': pgid,
                         'photo_url': r.get('photo_url', ''), 'player_profile_url': r.get('player_profile_url', ''), 'error': ''})
    print(f"{stats['rows']} photos to pack ({stats['assigned']} on a roster row, {stats['no_player']} without a scrape player, {stats['no_file']} missing files)", flush=True)
    t0 = time.time(); done = {'written': 0, 'kept': 0, 'failed': 0}; failed = {}
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for i, (dst, state, err) in enumerate(ex.map(convert, jobs, chunksize=16), 1):
            done[state] += 1
            if err: failed[os.path.basename(dst)] = err
            if i % 2000 == 0: print(f"  {i}/{len(jobs)} ({time.time() - t0:.0f}s)", flush=True)
    for row in out_rows:
        if row['filename'] in failed: row['status'], row['error'] = 'failed', failed[row['filename']]
    cols = ['status', 'filename', 'full_name', 'team_name', 'tgid', 'game_first', 'game_last', 'pgid', 'photo_url', 'player_profile_url', 'error']
    with open(os.path.join(a.out, 'player_photos_manifest.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(out_rows)
    total = sum(os.path.getsize(os.path.join(out_dir, r['filename'])) for r in out_rows if r['status'] == 'downloaded')
    print(f"done in {time.time() - t0:.0f}s: {done['written']} written, {done['kept']} kept, {done['failed']} failed; {total / 1e6:.1f} MB in {out_dir}")
    for k, v in list(failed.items())[:10]: print('  failed', k, v)

if __name__ == '__main__':
    main()
