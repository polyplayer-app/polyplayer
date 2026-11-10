#!/bin/bash
# Тестовая музыка для автотестов (тоны, генерируются ffmpeg). Папки создаются рядом: tests/media/...
set -e
cd "$(dirname "$0")"
M=media
rm -rf "$M"; mkdir -p "$M/Piano" "$M/Плейлист 1" "$M/Lo-Fi" "$M/Long" "$M/Outro/sub" "$M/showcase/Вход" "$M/showcase/Перерыв" "$M/showcase/Финал"
tone() { ffmpeg -v error -y -f lavfi -i "sine=frequency=$2:duration=$3" -ac 2 -ar 44100 "${@:4}" "$1"; }
for i in 1 2 3; do tone "$M/Piano/Piano track $i.mp3" $((300 + i * 60)) 8 -b:a 96k; done
cp "$M/Piano/"*.mp3 "$M/Плейлист 1/"
for i in 1 2; do tone "$M/Lo-Fi/Чилл $i.m4a" $((200 + i * 50)) 8 -c:a aac -b:a 96k; done
tone "$M/Long/Long mix.mp3" 220 420 -b:a 64k
tone "$M/Outro/end two.ogg" 500 3 -c:a libvorbis
tone "$M/Outro/sub/end one.wav" 520 3
echo x > "$M/Outro/readme.txt"
# длинные треки для снимков окна на сайте и в справке
for n in "Вход/Morning Light" "Вход/Open Doors" "Вход/Soft Focus" "Перерыв/Coffee Break" "Перерыв/Warm Strings" "Финал/Last Light" "Финал/See You Soon"; do
  tone "$M/showcase/$n.mp3" $((180 + RANDOM % 300)) $((176 + RANDOM % 65)) -b:a 32k
done
echo "media ready"
