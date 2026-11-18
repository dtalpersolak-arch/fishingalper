# ⚔️ Burnaz Sahil & Dörtyol - 2.5D İzometrik Balıkçılık & Lonca MMO

Node.js, Express ve Socket.io altyapısıyla güçlendirilmiş, gerçek zamanlı çok oyunculu (multiplayer) 2.5D izometrik tarayıcı MMO oyunu.

---

## 🚀 Hızlı Başlangıç (Yerel Çalıştırma)

1. **Bağımlılıkları Yükleyin:**
   ```bash
   npm install
   ```

2. **Sunucuyu Başlatın:**
   ```bash
   npm start
   ```

3. **Oyuna Giriş Yapın:**
   Tarayıcınızda [http://localhost:3000](http://localhost:3000) adresine gidin.

---

## 🚂 Railway Üzerinde Canlıya Alma (Deploy to Railway)

Bu proje Railway ile **%100 uyumlu** olarak yapılandırılmıştır.

1. Projeyi bir GitHub deposuna yükleyin (veya Railway CLI ile `railway up` çalıştırın).
2. Railway kontrol panelinden **New Project -> Deploy from GitHub repo** seçin.
3. Railway `package.json` dosyasını otomatik olarak algılar ve `npm install && npm start` komutlarını çalıştırır.
4. *(İsteğe Bağlı)* Railway panelinden tek tıkla **PostgreSQL** eklentisi ekleyebilirsiniz. Railway otomatik olarak `DATABASE_URL` ortam değişkenini tanımlar ve sunucu anında PostgreSQL moduna geçer. Eğer eklemezseniz sunucu yerel JSON veritabanı modunda çalışmaya devam eder.

### Ortam Değişkenleri (Environment Variables):
- `PORT`: Sunucu portu (Railway otomatik atar, varsayılan `3000`).
- `ADMIN_USERNAME`: Yönetici (GM) hesabı kullanıcı adı (Varsayılan: `burak`).
- `JWT_SECRET`: Güvenli oturum anahtarı (Varsayılan tanımlıdır).
- `DATABASE_URL`: PostgreSQL bağlantı adresi (Railway Postgres eklendiğinde otomatik gelir).

---

## 👑 Yönetici (GM) Yetkilendirme & Kontrol Paneli

- **İlk Kayıt Olan Hesap** veya kullanıcı adı **`burak`** olan hesap otomatik olarak `admin` (GM) yetkisine sahip olur.
- Diğer tüm kayıt olan oyuncular `player` rolüne sahiptir.
- **Sıradan oyuncular:**
  - `[P]` Kontrol Paneli kısayolu kesinlikle çalışmaz.
  - Arayüzdeki GM / Kontrol Paneli butonları görünmez.
  - Sunucu ve istemci seviyesinde tam yetki kısıtlaması uygulanır.
- **Yönetici hesabı:**
  - `[P]` tuşuna basarak veya sağ üstteki `👑 GM Kontrol Paneli` butonuna tıklayarak tüm oyun içi oranları, Kraken sefer saatlerini, eşyaları ve dropları canlı olarak yönetebilir.
  - Kafasının üstünde altın rengi `👑 GM` rozeti yer alır.

---

## 🎮 Temel Özellikler
- **Üyelik & Güvenli Giriş:** Kullanıcı adı, e-posta ve `bcrypt` ile şifrelenmiş parola koruması.
- **Karakter Döngüsü:** Yeni hesaplar karakter yaratma ekranına yönlendirilir; mevcut hesaplar doğrudan kendi karakteriyle oyuna başlar.
- **Çok Oyunculu Canlı Senkronizasyon (Socket.io):** Aynı haritadaki diğer oyuncuları görme, hareketlerini izleme, canlı olta atışları ve ortak sohbet.
- **Bulut Otomatik Kayıt:** Karakter eşyaları, altın, seviye ve envanter sunucuya düzenli olarak otomatik kaydedilir.
