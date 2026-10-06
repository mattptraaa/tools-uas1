# Bantuan Belajar | UT FAMILY (versi statis)

Versi tanpa server. Tidak ada folder api dan tidak ada file .env, jadi tidak ada tempat menyimpan rahasia di project ini.

Cara pakai: buka index.html di browser atau deploy ke Vercel/Netlify sebagai situs statis. Tiap pengguna menempel API key Gemini miliknya sendiri lewat ikon kunci di header (panduannya ada di sana). Kunci tersimpan di browser pengguna dan dikirim langsung ke Google.

Dapatkan kunci gratis di https://aistudio.google.com/apikey. Kunci baru diawali AQ., kunci lama diawali AIza. Kalau kunci AQ. ditolak, buat kunci klasik lewat Google Cloud Console (APIs and Services, Credentials, Create credentials, API key, batasi ke Generative Language API).

Batas file: sekitar 14 MB untuk PDF dan gambar per analisis. Format: PDF, DOCX, PPTX, TXT, PNG, JPG, WEBP.
Taruh logo-utfamily.png di folder assets agar tampil di header.
JSZip 3.10.1 (dual lisensi MIT atau GPL-3.0) disertakan di js/vendor.
