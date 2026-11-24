#!/bin/sh
# ssh SSH_ASKPASS yardımcısı: parolayı 0400 dosyadan verir (komut satırına/ortama yazılmaz).
exec cat -- "$AIB_SSH_PASSFILE"
