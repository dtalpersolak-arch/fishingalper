// ============================================================================
// BURNAZ SAHİL & DÖRTYOL - 2.5D İZOMETRİK BALIKÇILIK MMO
// ============================================================================

// Canvas roundRect Polyfill (Eski tarayıcılar / Webview uyumluluğu için)
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, radii) {
        if (!radii) radii = 0;
        let r = typeof radii === 'number' ? radii : (Array.isArray(radii) ? (radii[0] || 0) : 0);
        r = Math.min(Math.max(0, r), Math.abs(w) / 2, Math.abs(h) / 2);
        this.moveTo(x + r, y);
        this.arcTo(x + w, y, x + w, y + h, r);
        this.arcTo(x + w, y + h, x, y + h, r);
        this.arcTo(x, y + h, x, y, r);
        this.arcTo(x, y, x + w, y, r);
        this.closePath();
        return this;
    };
}

// Güvenli Depolama (localStorage izni kapalı veya file:// modunda çökmesini engeller)
const SafeStorage = {
    _mem: {},
    getItem(k) {
        try { return localStorage.getItem(k); } catch (e) { return this._mem[k] || null; }
    },
    setItem(k, v) {
        try { localStorage.setItem(k, v); } catch (e) { this._mem[k] = String(v); }
    },
    removeItem(k) {
        try { localStorage.removeItem(k); } catch (e) { delete this._mem[k]; }
    }
};

// ============================================================================
// ONLINE MULTIPLAYER & HESAP YÖNETİMİ DURUMU (Railway / Node.js Uyumlu)
// ============================================================================
let currentUser = null;
let authToken = SafeStorage.getItem('mmo_auth_token') || null;
let serverOnline = false;
let socket = null;
let remotePlayers = {};
let lastMoveEmitTime = 0;

function getServerApiUrl(endpoint) {
    if (!endpoint) endpoint = '';
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : (endpoint ? `/${endpoint}` : '');

    // 1. Manuel belirlenmiş sunucu URL'si (ör. Railway)
    const customUrl = SafeStorage.getItem('mmo_server_url') || (new URLSearchParams(window.location.search).get('server'));
    if (customUrl && typeof customUrl === 'string' && customUrl.trim()) {
        return customUrl.trim().replace(/\/$/, '') + cleanEndpoint;
    }

    // 2. Dosya protokolü (file:///) veya port 3000 harici yerel sunucu (Live Server 5500 vb.)
    if (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))) {
        return `http://localhost:3000${cleanEndpoint}`;
    }

    // 3. Varsayılan aynı origin
    return cleanEndpoint;
}

function saveLocalAccount(username, email, password, role) {
    try {
        const raw = SafeStorage.getItem('mmo_local_accounts');
        const accounts = raw ? JSON.parse(raw) : [];
        const lower = (username || '').trim().toLowerCase();
        if (!lower) return;
        const existingIdx = accounts.findIndex(a => a.username && a.username.toLowerCase() === lower);
        const accObj = {
            username: username.trim(),
            email: (email || '').trim().toLowerCase(),
            password: password,
            role: role || (lower === 'burak' || lower === 'admin' ? 'admin' : 'player'),
            savedAt: Date.now()
        };
        if (existingIdx >= 0) {
            accounts[existingIdx] = accObj;
        } else {
            accounts.push(accObj);
        }
        SafeStorage.setItem('mmo_local_accounts', JSON.stringify(accounts));
    } catch(e) {
        console.warn('Yerel hesap kaydedilemedi:', e);
    }
}

function findLocalAccount(identifier) {
    try {
        const raw = SafeStorage.getItem('mmo_local_accounts');
        if (!raw) return null;
        const accounts = JSON.parse(raw);
        if (!Array.isArray(accounts)) return null;
        const lower = (identifier || '').trim().toLowerCase();
        if (!lower) return null;
        return accounts.find(a => 
            (a.username && a.username.toLowerCase() === lower) || 
            (a.email && a.email.toLowerCase() === lower)
        ) || null;
    } catch(e) {
        return null;
    }
}

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const previewCanvas = document.getElementById('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');

let viewWidth = window.innerWidth;
let viewHeight = window.innerHeight;

function resizeCanvas() {
    viewWidth = window.innerWidth;
    viewHeight = window.innerHeight;
    canvas.width = viewWidth;
    canvas.height = viewHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ============================================================================
// 1. İZOMETRİK PROJEKSİYON & HARİTA SABİTLERİ
// ============================================================================
const MAP_SIZE = 28;
const TILE_W = 68;
const TILE_H = 34;

const TILE = {
    DEEP_SEA: 0,
    SEA: 1,
    SAND: 2,
    GRASS: 3,
    LAKE: 4,
    PIER: 5,
    COBBLE: 6,
    PLAZA: 7
};

function tileToScreen(x, y) {
    return {
        x: (x - y) * (TILE_W / 2),
        y: (x + y) * (TILE_H / 2)
    };
}

function screenToTile(screenX, screenY, camX, camY) {
    const wx = screenX - camX;
    const wy = screenY - camY;
    return {
        x: (wx / (TILE_W / 2) + wy / (TILE_H / 2)) / 2,
        y: (wy / (TILE_H / 2) - wx / (TILE_W / 2)) / 2
    };
}

// ============================================================================
// 2. HARİTALAR: BURNAZ SAHİL, DÖRTYOL (ANA ŞEHİR) & AKDENİZ (AÇIK OKYANUS)
// ============================================================================
const maps = {
    burnaz_sahil: {
        id: 'burnaz_sahil',
        name: 'Burnaz Sahil',
        grid: [],
        props: [],
        interactables: []
    },
    dortyol: {
        id: 'dortyol',
        name: 'Dörtyol (Ana Şehir)',
        grid: [],
        props: [],
        interactables: []
    },
    akdeniz: {
        id: 'akdeniz',
        name: 'Akdeniz (Açık Okyanus)',
        grid: [],
        props: [],
        interactables: []
    },
    kraken: {
        id: 'kraken',
        name: 'Kraken Bölgesi (Kızıl Okyanus)',
        grid: [],
        props: [],
        interactables: []
    }
};

let currentMapId = 'burnaz_sahil';

function buildBurnazSahil() {
    const m = maps.burnaz_sahil;
    for (let y = 0; y < MAP_SIZE; y++) {
        m.grid[y] = [];
        for (let x = 0; x < MAP_SIZE; x++) {
            const distLake = Math.hypot((x - 7.5) * 1.1, (y - 8.5) * 0.95);
            const seaLine = x * 0.85 + y * 0.45 + Math.sin(y * 0.45) * 1.2;

            if (distLake < 3.6) {
                m.grid[y][x] = TILE.LAKE;
            } else if (seaLine > 21.5) {
                m.grid[y][x] = TILE.DEEP_SEA;
            } else if (seaLine > 18.2) {
                m.grid[y][x] = TILE.SEA;
            } else if (seaLine > 13.5 || distLake < 4.8) {
                m.grid[y][x] = TILE.SAND;
            } else {
                m.grid[y][x] = TILE.GRASS;
            }
        }
    }

    // Denize uzanan ana ahşap iskele
    for (let x = 14; x <= 21; x++) {
        m.grid[12][x] = TILE.PIER;
        m.grid[13][x] = TILE.PIER;
    }

    // Sol tarafta deniz kenarında Tersane / Tekne İskelesi ve Taş Zemin
    m.grid[20][9] = TILE.PLAZA;
    m.grid[21][9] = TILE.PLAZA;
    m.grid[20][10] = TILE.PIER;
    m.grid[21][10] = TILE.PIER;
    m.grid[20][11] = TILE.SEA;
    m.grid[21][11] = TILE.SEA;

    // Gölün yanındaki taş zemin (Işınlanma Taşı çevresi)
    m.grid[8][12] = TILE.PLAZA;
    m.grid[9][12] = TILE.PLAZA;

    m.props = [
        { x: 4, y: 4, type: 'palm' },
        { x: 11, y: 4, type: 'palm' },
        { x: 3, y: 13, type: 'palm' },
        { x: 11, y: 16, type: 'palm' },
        { x: 7, y: 19, type: 'palm' },
        { x: 15, y: 7, type: 'palm' },
        { x: 5, y: 6, type: 'reed' },
        { x: 10, y: 6, type: 'reed' },
        { x: 6, y: 11, type: 'reed' },
        { x: 9, y: 11, type: 'rock' },
        { x: 4, y: 9, type: 'rock' },
        { x: 14, y: 17, type: 'starfish' },
        { x: 16, y: 10, type: 'starfish' },
        { x: 12, y: 21, type: 'shell' },
        { x: 16, y: 6, type: 'shell' }
    ];

    m.interactables = [
        {
            id: 'tp_to_dortyol',
            type: 'teleport',
            name: 'Işınlanma Taşı',
            subtitle: 'Dörtyol (Ana Şehir)',
            x: 12.5,
            y: 8.5,
            targetMap: 'dortyol',
            targetX: 13.5,
            targetY: 23.5
        },
        {
            id: 'npc_shipyard',
            type: 'shipyard',
            name: 'Tersane Kaptanı Barbaros',
            subtitle: 'Tekne & Gemi Tersanesi (Akdeniz\'e Açıl - Min. Lv.10)',
            x: 9.5,
            y: 20.5,
            coatColor: '#1d3557',
            hatColor: '#e63946'
        }
    ];
}

function buildDortyol() {
    const m = maps.dortyol;
    // 1. Temel Izgara ve Yol Ağı (Ferah Yeşil Çim Zemin, Taş Yollar ve Mermer Meydanlar)
    for (let y = 0; y < MAP_SIZE; y++) {
        m.grid[y] = [];
        for (let x = 0; x < MAP_SIZE; x++) {
            m.grid[y][x] = TILE.GRASS;
        }
    }

    // Geniş Merkez Bulvarları (Ana Taş Yollar)
    for (let y = 2; y <= 25; y++) {
        for (let x = 12; x <= 15; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }
    for (let y = 12; y <= 15; y++) {
        for (let x = 2; x <= 25; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }

    // Merkez Şelale Meydanı (Geniş Dairesel Mermer Plaza)
    for (let y = 10; y <= 17; y++) {
        for (let x = 10; x <= 17; x++) {
            const distCenter = Math.hypot(x - 13.5, y - 13.5);
            if (distCenter <= 4.2) {
                m.grid[y][x] = TILE.PLAZA;
            }
        }
    }

    // Kuzey: Hükümet Konağı & Muhtar Ahmet Meydanı (x: 11..16, y: 2..6)
    for (let y = 2; y <= 6; y++) {
        for (let x = 11; x <= 16; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }

    // Kuzeydoğu: Lonca Tapınağı & Karargâh Meydanı (TAMAMEN KORUNDU)
    for (let py = 3; py <= 7; py++) {
        for (let px = 18; px <= 24; px++) {
            m.grid[py][px] = TILE.PLAZA;
        }
    }
    // Lonca Bağlantı Yolu
    for (let py = 6; py <= 8; py++) {
        for (let px = 15; px <= 19; px++) {
            if (m.grid[py][px] !== TILE.PLAZA) {
                m.grid[py][px] = TILE.COBBLE;
            }
        }
    }

    // Kuzeybatı: Büyü Kulesi Meydanı (Simyacı Efsun - x: 2..7, y: 2..7)
    for (let y = 2; y <= 7; y++) {
        for (let x = 2; x <= 7; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }
    // NW Bağlantı Yolu
    for (let y = 6; y <= 8; y++) {
        for (let x = 7; x <= 12; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }

    // Batı: Merkez Bankası & Depo Meydanı (Depocu Tarık - x: 2..7, y: 11..16)
    for (let y = 11; y <= 16; y++) {
        for (let x = 2; x <= 7; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }

    // Doğu: Tek Başına Efsunlu Örs Meydanı (Anvil - x: 18..21, y: 12..15)
    for (let y = 12; y <= 15; y++) {
        for (let x = 18; x <= 21; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }

    // Uzak Doğu: Şans Köşkü Meydanı (Bahisçi Bülo - x: 23..27, y: 9..14)
    for (let y = 9; y <= 14; y++) {
        for (let x = 23; x <= 27; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }
    for (let y = 11; y <= 13; y++) {
        for (let x = 21; x <= 23; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }

    // Güneybatı: Marangoz Çınar Atölyesi (x: 2..7, y: 20..25)
    for (let y = 20; y <= 25; y++) {
        for (let x = 2; x <= 7; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }
    for (let y = 16; y <= 21; y++) {
        for (let x = 5; x <= 7; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }

    // Güneydoğu: Gurme Fırın Meydanı (Şef Gusto - x: 22..26, y: 19..24)
    for (let y = 19; y <= 24; y++) {
        for (let x = 22; x <= 26; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }
    for (let y = 16; y <= 20; y++) {
        for (let x = 20; x <= 22; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }

    // Güney Limanı: Balıkçı Barınağı İskelesi (Balıkçı Reis - x: 16..20, y: 22..26)
    for (let y = 22; y <= 26; y++) {
        for (let x = 16; x <= 20; x++) {
            m.grid[y][x] = TILE.COBBLE;
        }
    }

    // Güney Kapısı: Işınlanma Mabedi (x: 11..16, y: 23..26)
    for (let y = 23; y <= 26; y++) {
        for (let x = 11; x <= 16; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }

    // Dörtyol Pazarı & Açık Artırma Meydanı (Pazarcı Mustafa - x: 8..11, y: 17..21)
    for (let y = 17; y <= 21; y++) {
        for (let x = 8; x <= 11; x++) {
            m.grid[y][x] = TILE.PLAZA;
        }
    }
    for (let x = 11; x <= 12; x++) {
        m.grid[18][x] = TILE.COBBLE;
        m.grid[19][x] = TILE.COBBLE;
    }

    m.props = [
        // 1. Merkez Şelale Fışkiyesi & Meydan Süslemeleri
        { x: 13, y: 13, type: 'cascade_fountain' },
        { x: 10, y: 10, type: 'lantern' },
        { x: 17, y: 10, type: 'lantern' },
        { x: 10, y: 17, type: 'lantern' },
        { x: 17, y: 17, type: 'lantern' },
        { x: 11, y: 13, type: 'stone_bench' },
        { x: 16, y: 13, type: 'stone_bench' },
        { x: 13, y: 11, type: 'planter' },
        { x: 14, y: 16, type: 'planter' },

        // 2. Kuzey: Hükümet Konağı (Muhtar Ahmet)
        { x: 13, y: 2, type: 'town_hall' },
        { x: 11, y: 5, type: 'lantern' },
        { x: 16, y: 5, type: 'lantern' },

        // 3. Kuzeydoğu: Lonca Tapınağı (TAMAMEN KORUNDU)
        { x: 21, y: 4, type: 'guild_temple' },
        { x: 19, y: 5, type: 'brazier' },
        { x: 23, y: 5, type: 'brazier' },

        // 4. Kuzeybatı: Büyü Kulesi (Simyacı Efsun)
        { x: 4, y: 3, type: 'alchemy_tower' },
        { x: 2, y: 5, type: 'lantern' },
        { x: 6, y: 5, type: 'planter' },

        // 5. Batı: Merkez Bankası & Depo (Depocu Tarık)
        { x: 4, y: 12, type: 'bank_vault' },
        { x: 2, y: 14, type: 'lantern' },
        { x: 6, y: 14, type: 'planter' },

        // 6. Uzak Doğu: Şans Köşkü (Bahisçi Bülo)
        { x: 25, y: 10, type: 'gambler_pavilion' },
        { x: 23, y: 12, type: 'lantern' },
        { x: 26, y: 13, type: 'lantern' },

        // 7. Güneybatı: Marangoz Çınar Atölyesi
        { x: 4, y: 21, type: 'carpenter_workshop' },
        { x: 2, y: 23, type: 'lantern' },
        { x: 6, y: 23, type: 'planter' },

        // 8. Güneydoğu: Gurme Fırın (Şef Gusto)
        { x: 24, y: 20, type: 'bakery_tavern' },
        { x: 22, y: 22, type: 'lantern' },
        { x: 25, y: 23, type: 'lantern' },

        // 9. Güney Limanı: Balıkçı Barınağı (Balıkçı Reis)
        { x: 18, y: 23, type: 'fisher_shack' },
        { x: 20, y: 25, type: 'lantern' },

        // 10. Güney Kapısı: Işınlanma Mabedi
        { x: 11, y: 25, type: 'brazier' },
        { x: 16, y: 25, type: 'brazier' },

        // Çevre Ağaçlandırmaları (Park ve Yeşil Doğa Kuşakları)
        { x: 8, y: 3, type: 'oak' },
        { x: 3, y: 8, type: 'oak' },
        { x: 8, y: 9, type: 'oak' },
        { x: 3, y: 18, type: 'oak' },
        // 11. Dörtyol Pazarı & Açık Artırma Binası (Pazarcı Mustafa)
        { x: 9.5, y: 18, type: 'market_bazaar' },
        { x: 8, y: 20, type: 'lantern' },
        { x: 11, y: 20, type: 'lantern' },
        { x: 8, y: 24, type: 'oak' },
        { x: 25, y: 3, type: 'oak' },
        { x: 24, y: 7, type: 'oak' },
        { x: 25, y: 17, type: 'oak' },
        { x: 21, y: 25, type: 'oak' }
    ];

    m.interactables = [
        {
            id: 'tp_to_burnaz',
            type: 'teleport',
            name: 'Işınlanma Taşı',
            x: 13.5,
            y: 25.0,
            targetMap: 'burnaz_sahil',
            targetX: 12.5,
            targetY: 9.8
        },
        // LONCA NPC LERİ (TAMAMEN KORUNDU)
        {
            id: 'npc_guild_master',
            type: 'guild',
            name: 'Lonca Lideri',
            x: 21.0,
            y: 6.2,
            coatColor: '#7209b7',
            hatColor: '#ffd166'
        },
        {
            id: 'npc_guild_guard',
            type: 'guild_guard',
            name: 'Lonca Muhafızı',
            x: 22.8,
            y: 6.2,
            coatColor: '#3a0ca3',
            hatColor: '#4cc9f0'
        },
        // DAĞITILMIŞ FERAH NPC KONUMLARI (AÇIKLAMALAR SİLİNDİ, İÇ İÇE GİRME BİTTİ)
        {
            id: 'npc_headman',
            type: 'headman',
            name: 'Muhtar Ahmet',
            x: 13.5,
            y: 5.5,
            coatColor: '#1d3557',
            hatColor: '#d4a373'
        },
        {
            id: 'npc_alchemist',
            type: 'alchemist',
            name: 'Simyacı Efsun',
            x: 4.5,
            y: 5.8,
            coatColor: '#9b5de5',
            hatColor: '#5a189a'
        },
        {
            id: 'npc_tailor',
            type: 'tailor',
            name: 'Kostümcü Selim',
            x: 6.2,
            y: 5.2,
            coatColor: '#e76f51',
            hatColor: '#264653'
        },
        {
            id: 'npc_storage',
            type: 'storage',
            name: 'Depocu Tarık',
            x: 4.5,
            y: 14.8,
            coatColor: '#3a86ff',
            hatColor: '#1d3557'
        },
        {
            id: 'npc_market_mustafa',
            type: 'market',
            name: 'Pazarcı Mustafa',
            subtitle: 'Dörtyol Pazarı • Açık Artırma & Pazar Yeri',
            x: 9.5,
            y: 20.2,
            coatColor: '#e07a5f',
            hatColor: '#3d405b'
        },
        {
            id: 'station_anvil',
            type: 'anvil',
            name: 'Efsunlu Örs',
            x: 19.5,
            y: 13.5
        },
        {
            id: 'npc_gambler',
            type: 'gambler',
            name: 'Bahisçi Bülo',
            x: 25.0,
            y: 13.0,
            coatColor: '#d90429',
            hatColor: '#2b2d42'
        },
        {
            id: 'npc_carpenter',
            type: 'carpenter',
            name: 'Marangoz Çınar',
            x: 4.5,
            y: 23.8,
            coatColor: '#bc6c25',
            hatColor: '#606c38'
        },
        {
            id: 'npc_chef',
            type: 'chef',
            name: 'Şef Gusto',
            x: 24.0,
            y: 23.0,
            coatColor: '#f8f9fa',
            hatColor: '#ffffff'
        },
        {
            id: 'npc_fisherman',
            type: 'fisherman',
            name: 'Balıkçı Reis',
            x: 18.0,
            y: 25.5,
            coatColor: '#f4a261',
            hatColor: '#e76f51'
        }
    ];
}

// 3. Harita: AKDENİZ (Tamamen Sudan Oluşan Okyanus Haritası + Ortada Minik Ada & Işınlanma Taşı)
function buildAkdeniz() {
    const m = maps.akdeniz;
    for (let y = 0; y < MAP_SIZE; y++) {
        m.grid[y] = [];
        for (let x = 0; x < MAP_SIZE; x++) {
            const distCenter = Math.hypot(x - 13.5, y - 13.5);
            if (distCenter < 1.1) {
                // Ortadaki minik adanın merkezi (Işınlanma taşı zemini)
                m.grid[y][x] = TILE.PLAZA;
            } else if (distCenter < 2.1) {
                // Minik adanın kumsalı
                m.grid[y][x] = TILE.SAND;
            } else if (distCenter < 4.2) {
                // Ada çevresi sığ deniz
                m.grid[y][x] = TILE.SEA;
            } else {
                // Açık Okyanus
                m.grid[y][x] = TILE.DEEP_SEA;
            }
        }
    }

    m.props = [
        { x: 12, y: 12, type: 'palm' },
        { x: 15, y: 13, type: 'shell' },
        { x: 13, y: 15, type: 'starfish' }
    ];

    m.interactables = [
        {
            id: 'tp_akdeniz_to_dortyol',
            type: 'teleport',
            name: 'Ada Işınlanma Taşı',
            subtitle: 'Dörtyol (Ana Şehir)',
            x: 13.5,
            y: 13.5,
            targetMap: 'dortyol',
            targetX: 13.5,
            targetY: 23.5
        }
    ];
}

// 4. Harita: KRAKEN BÖLGESİ (Kızıl Okyanus - Lonca Raid & Kraken Haritası)
function buildKraken() {
    const m = maps.kraken;
    for (let y = 0; y < MAP_SIZE; y++) {
        m.grid[y] = [];
        for (let x = 0; x < MAP_SIZE; x++) {
            // Tamamen Kızıl Derin Okyanus Suyu
            m.grid[y][x] = TILE.DEEP_SEA;
        }
    }
    m.props = [
        { x: 4, y: 4, type: 'kraken_reef' },
        { x: 23, y: 5, type: 'kraken_wreck' },
        { x: 5, y: 22, type: 'kraken_wreck' },
        { x: 22, y: 23, type: 'kraken_reef' }
    ];
    m.interactables = [
        {
            id: 'tp_kraken_to_dortyol',
            type: 'teleport',
            name: 'Karargâha Dönüş Feneri',
            subtitle: 'Dörtyol Lonca Karargâhı',
            x: 13.5,
            y: 13.5,
            targetMap: 'dortyol',
            targetX: 21.5,
            targetY: 7.5
        }
    ];
}

buildBurnazSahil();
buildDortyol();
buildAkdeniz();
buildKraken();

function getActiveMap() {
    return maps[currentMapId];
}

function isWalkable(tx, ty) {
    const m = getActiveMap();
    if (tx < 0 || ty < 0 || tx >= MAP_SIZE || ty >= MAP_SIZE) return false;
    const t = m.grid[ty][tx];

    // Akdeniz haritasında tekne ile su üzerinde hareket edilir!
    if (currentMapId === 'akdeniz') {
        for (const inter of m.interactables) {
            if (Math.floor(inter.x) === tx && Math.floor(inter.y) === ty) {
                return false;
            }
        }
        // Minik adanın tam ortasına tekne çıkamaz ama sığ suya ve kıyıya yanaşabilir
        if (t === TILE.PLAZA) return false;
        return t === TILE.DEEP_SEA || t === TILE.SEA || t === TILE.SAND;
    }

    // Kraken Haritası: Lonca Destroyer'i ile su üzerinde sınırsız hareket edilir!
    if (currentMapId === 'kraken') {
        return tx >= 1 && ty >= 1 && tx < MAP_SIZE - 1 && ty < MAP_SIZE - 1;
    }

    if (t === TILE.DEEP_SEA || t === TILE.SEA || t === TILE.LAKE) return false;

    for (const p of m.props) {
        if (p.x === tx && p.y === ty && (p.type === 'palm' || p.type === 'oak' || p.type === 'rock' || p.type === 'fountain' || p.type === 'brazier' || p.type === 'cascade_fountain')) {
            return false;
        }
        if (p.type === 'guild_temple' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'town_hall' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'alchemy_tower' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'bank_vault' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'gambler_pavilion' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'carpenter_workshop' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'bakery_tavern' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'market_bazaar' && Math.abs(tx - p.x) <= 1 && (ty === p.y || ty === p.y - 1)) {
            return false;
        }
        if (p.type === 'fisher_shack' && Math.abs(tx - p.x) <= 1 && ty === p.y) {
            return false;
        }
    }
    for (const inter of m.interactables) {
        if (Math.floor(inter.x) === tx && Math.floor(inter.y) === ty) {
            return false;
        }
    }
    return true;
}

function isWaterTile(tx, ty) {
    const m = getActiveMap();
    if (tx < 0 || ty < 0 || tx >= MAP_SIZE || ty >= MAP_SIZE) return false;
    const t = m.grid[ty][tx];
    return t === TILE.SEA || t === TILE.DEEP_SEA || t === TILE.LAKE;
}

// ============================================================================
// 3. NADİRLİK SINIFLARI, TEKNELER, BALIK İHTİMALLERİ, EXP VE EŞYA VERİTABANI
// ============================================================================
// İhtimaller: Sıradan %80, Gelişmiş %10, Nadir %6, Destansı %3, Efsanevi %1
// EXP Kazancı: Sıradan %5, Gelişmiş %7, Nadir %9, Destansı %10, Efsanevi %12
const RARITY = {
    COMMON: {
        id: 'common', name: 'Sıradan', color: '#adb5bd',
        baseChance: 80, expGain: 5,
        greenWidth: 32, speed: 0.90,
        buffType: 'speed', buffVal: 3, buffDesc: 'Balık bekleme süresini %3 azaltır (10 dk)'
    },
    UNCOMMON: {
        id: 'uncommon', name: 'Gelişmiş', color: '#52b788',
        baseChance: 10, expGain: 7,
        greenWidth: 24, speed: 1.25,
        buffType: 'luck', buffVal: 3, buffDesc: 'Nadir balık yakalama şansını %3 artırır (10 dk)'
    },
    RARE: {
        id: 'rare', name: 'Nadir', color: '#4cc9f0',
        baseChance: 6, expGain: 9,
        greenWidth: 18, speed: 1.60,
        buffType: 'speed', buffVal: 5, buffDesc: 'Balık tutma süresini %5 azaltır (10 dk)'
    },
    EPIC: {
        id: 'epic', name: 'Destansı', color: '#c77dff',
        baseChance: 3, expGain: 10,
        greenWidth: 13, speed: 2.00,
        buffType: 'control', buffVal: 5, buffDesc: 'Bar hızını %5 yavaşlatır ve şansı %3 artırır (10 dk)'
    },
    LEGENDARY: {
        id: 'legendary', name: 'Efsanevi', color: '#ffbe0b',
        baseChance: 1, expGain: 12,
        greenWidth: 9, speed: 2.45,
        buffType: 'luck', buffVal: 5, buffDesc: 'Efsanevi balık tutma şansını %5 artırır (10 dk)'
    }
};

// Efsun Basma Başarı İhtimalleri ve Oyun Kuralları (Kontrol Panelinden Düzenlenebilir)
let ENCHANT_SUCCESS_RATES = [100, 40, 20, 10, 5];
let MAX_ENCHANT_COUNT = 5;
const MAX_PLAYER_LEVEL = 20;

const GAME_RULES = {
    minWaitSec: 10,
    maxWaitSec: 20,
    autoHuntTimeMult: 4.0,
    autoHuntLuckMult: 0.3333,
    destroyRodOnFail: true,
    // Akdeniz & Sarı Bölge & Craft Drop Kuralları
    akdenizMinLevel: 10,
    pearlDropChance: 0.5,            // %0.5 İnci Drop İhtimali
    treasureDropChance: 1.0,         // %1.0 Ölü Denizcinin Hazinesi Drop İhtimali
    pirateTreasureDropChance: 0.1,   // %0.1 Korsan Hazinesi Drop İhtimali (SADECE Sarı Bereket Bölgesi)
    royalGuardDropChance: 0.01,      // %0.01 Kraliyet Muhafızı Kostümü Drop İhtimali (Akdeniz Okyanus)
    hotspotLuckMult: 1.5,            // Sarı Bölgede 1.5x değerli balık şansı
    hotspotDurationSec: 300,         // 5 dakikada bir (300 sn) yer değiştirir
    hotspotRadius: 2.8,              // Küçük sarı alan yarıçapı
    // Bahisçi Bülo Hazine Sandığı Oranları
    gamblerPearlChance: 1.0,         // %1.0 İnci Şansı
    gamblerProtectScrollChance: 1.0, // %1.0 Koruma Parşömeni Şansı
    // Marangoz Craft Ayarları
    craftBurakPearls: 5,             // Efsunlu Olta Craft İnci İhtiyacı
    craftBurakTreasures: 2           // Efsunlu Olta Craft Hazine İhtiyacı
};

// TEKNELER VERİTABANI (Envantere girmez, bir kez alınınca kalıcı olur ve Akdeniz'e ışınlar)
const BOATS = {
    boat_raft: {
        id: 'boat_raft',
        name: 'Ahşap Sal',
        speedLabel: 'Çok Yavaş',
        speed: 2.2,
        price: 250,
        hullColor: '#8c6239',
        accentColor: '#d4a373',
        desc: 'Birbirine halatlarla bağlanmış kütüklerden oluşan basit sal. Hareket hızı çok yavaştır ama Akdeniz\'e açılmanı sağlar.',
        customImage: null
    },
    boat_boat: {
        id: 'boat_boat',
        name: 'Balıkçı Teknesi',
        speedLabel: 'Yavaş',
        speed: 3.5,
        price: 650,
        hullColor: '#457b9d',
        accentColor: '#f1faee',
        desc: 'Klasik ahşap-fiber gövdeli kıyı balıkçı teknesi. Hareket hızı yavaştır, dalgalara karşı dengelidir.',
        customImage: null
    },
    boat_yacht: {
        id: 'boat_yacht',
        name: 'Lüks Yat',
        speedLabel: 'Normal',
        speed: 5.0,
        price: 1500,
        hullColor: '#f8f9fa',
        accentColor: '#00b4d8',
        desc: 'Geniş güverteli modern beyaz yat. Akdeniz sularında normal ve konforlu bir hızda seyreder.',
        customImage: null
    },
    boat_speedboat: {
        id: 'boat_speedboat',
        name: 'Sürat Teknesi',
        speedLabel: 'Yüksek',
        speed: 7.2,
        price: 3200,
        hullColor: '#e63946',
        accentColor: '#ffbe0b',
        desc: 'Çift turbo motorlu aerodinamik sürat teknesi! Sarı bölgelere herkesten önce ulaşmak için yüksek hız sunar.',
        customImage: null
    },
    boat_minnkota: {
        id: 'boat_minnkota',
        name: "Minnkota'lı Balıkçı Teknesi",
        speedLabel: 'Çok Hızlı (Otopilot)',
        speed: 8.5,
        price: 0,
        priceItem: 'item_pirate_treasure',
        priceItemCount: 10,
        hullColor: '#0b1d3a',
        accentColor: '#00f5d4',
        desc: "Akıllı Minn Kota GPS çapa motoru ile donatılmış son teknoloji balıkçı teknesi. [O] tuşu ile Auto-Hunt açıldığında otomatik olarak Sarı Bereket Bölgesi'ne gider ve avlanır. Sarı Bölge yer değiştirdiğinde avlanmayı durdurup yeni bölgeye doğru seyreder ve avlanmayı sürdürür! Satın almak için 10 adet Korsan Hazinesi gereklidir.",
        customImage: null
    },
    boat_destroyer: {
        id: 'boat_destroyer',
        name: "Lonca Destroyer'i",
        speedLabel: 'Zırhlı Savaş Gemisi',
        speed: 6.2,
        price: 0,
        priceItem: 'item_pearl',
        priceItemCount: 5,
        hullColor: '#18181b',
        accentColor: '#dc2626',
        desc: "Lonca için inşa edilmiş devasa zırhlı savaş gemisi. Lonca Muhafızından 5 İnci ile satın alınır. Kraken haritasında tüm lonca üyelerini taşır ve olta atmalarını sağlar. Dümen Lonca Liderindedir.",
        customImage: null
    }
};

// Oyun başlatma durumu (Erken çağrılan fonksiyonlarda TDZ hatalarını önler)
let isGameReady = false;

// Akdeniz Sarı Bölge (Her 5 dakikada bir rastgele yer değiştiren 1.5x Şans Alanı)
const oceanHotspot = {
    x: 8.5,
    y: 9.5,
    timer: 300
};

function relocateOceanHotspot(announce = false) {
    let rx = 7.5;
    let ry = 8.5;
    for (let tries = 0; tries < 30; tries++) {
        const cx = 4 + Math.floor(Math.random() * (MAP_SIZE - 8)) + 0.5;
        const cy = 4 + Math.floor(Math.random() * (MAP_SIZE - 8)) + 0.5;
        // Ortadaki minik adaya (13.5, 13.5) çok yakın olmasın
        if (Math.hypot(cx - 13.5, cy - 13.5) >= 5.2) {
            rx = cx;
            ry = cy;
            break;
        }
    }
    oceanHotspot.x = rx;
    oceanHotspot.y = ry;
    oceanHotspot.timer = GAME_RULES.hotspotDurationSec || 300;
    if (announce && currentMapId === 'akdeniz') {
        showToast('🌟 Akdeniz\'deki Sarı Bereket Bölgesi (1.5x Değerli Balık) yeni bir noktaya yer değiştirdi!', '#ffd166');
    }

    // Minnkota Otopilot: Sarı Bölge yer değiştirdiğinde avlanmayı durdur ve yeni konuma doğru seyre çık!
    if (isGameReady && autoHunt && autoHunt.active && player && player.activeBoatId === 'boat_minnkota' && currentMapId === 'akdeniz') {
        if (typeof cancelFishing === 'function') cancelFishing();
        autoHunt.navigatingToHotspot = true;
        const path = findPath(player.x, player.y, oceanHotspot.x, oceanHotspot.y);
        if (path && path.length > 0) {
            player.path = path;
        }
        showToast("🧭 [Minnkota Otopilot] Sarı Bölge yer değiştirdi! Tekne yeni koordinatlara rotasını çeviriyor...", '#ffd166');
        if (typeof updateAutoHuntHUD === 'function') updateAutoHuntHUD();
    }
}
relocateOceanHotspot(false);

function isInOceanHotspot(tx, ty) {
    if (currentMapId !== 'akdeniz') return false;
    const r = GAME_RULES.hotspotRadius || 2.8;
    return Math.hypot(tx - oceanHotspot.x, ty - oceanHotspot.y) <= r;
}

// Özel Yüklenen Görsellerin Önbelleği (Image Cache)
const customImageCache = {};
function getCustomImageObj(src) {
    if (!src) return null;
    if (!customImageCache[src]) {
        const img = new Image();
        img.src = src;
        customImageCache[src] = img;
    }
    return customImageCache[src];
}

// Pasif Yetenek Ağacı Tanımları (K Tuşu)
const PASSIVE_SKILLS = [
    {
        id: 'burak_tactics',
        name: 'Burak Reisin Taktikleri',
        icon: '🧭',
        desc: 'Usta balıkçı Burak Reisin gizli avlanma taktikleri sayesinde nadir balıkların oltaya gelme ihtimali artar.',
        perLevelText: 'Seviye başına Nadirlik Şansı +%2',
        maxLevel: 5,
        effectPerLevel: 2
    },
    {
        id: 'talha_luck',
        name: 'Talha Reisin Balı',
        icon: '🍯',
        desc: 'Talha Reisin dillere destan şansı ile balıklar oltana çok daha erken vurur.',
        perLevelText: 'Seviye başına Balık Tutma Süresi -%5',
        maxLevel: 5,
        effectPerLevel: 5
    },
    {
        id: 'duran_beret',
        name: 'Duran Beyin Beresi',
        icon: '🧢',
        desc: 'Duran Beyin efsanevi beresi soğukkanlılık kazandırır; balık yakalama barındaki çizgi daha yavaş hareket eder.',
        perLevelText: 'Seviye başına Bar Hareket Hızı -%3',
        maxLevel: 5,
        effectPerLevel: 3
    },
    {
        id: 'chef_gusto_mastery',
        name: 'Gusto Şef\'in Mahareti',
        icon: '👨‍🍳',
        desc: 'Şef Gusto\'nun mutfak sırları sayesinde pişirdiğin balıkların sağladığı yemek bufflarının süresini uzatır (%50\'ye kadar).',
        perLevelText: 'Seviyelere göre Buff Süresi: +%10 / +%20 / +%30 / +%40 / +%50',
        maxLevel: 5,
        effectPerLevel: 10
    },
    {
        id: 'carpenter_wisdom',
        name: 'Marangoz\'un Bilgeliği',
        icon: '🪚',
        desc: 'Marangoz Çınar\'ın atölyesinde zanaat yaparken kadim ustalık sayesinde craft malzemelerinin harcanmasını engeller.',
        perLevelText: 'Seviyelere göre Malzeme Koruma: +%1 / +%2 / +%3 / +%4 / +%5',
        maxLevel: 5,
        effectPerLevel: 1
    },
    {
        id: 'anvil_patron',
        name: 'Anvil\'in Patronu',
        icon: '🔨',
        desc: 'Efsunlu Örs\'ün gizemini çözerek Anvil\'de oltana efsun ve artı basarken başarı ihtimalini artırır.',
        perLevelText: 'Seviyelere göre Anvil Başarı Oranı: +%1 / +%2 / +%3 / +%4 / +%5',
        maxLevel: 5,
        effectPerLevel: 1
    },
    {
        id: 'fisherman_prayer',
        name: 'Balıkçının Duası',
        icon: '🙏',
        desc: 'Balık avlarken taktığın yemin korunması ihtimalini artırır. Balık yakaladığında yemin eksilmez.',
        perLevelText: 'Seviyelere göre Yem Koruma Şansı: %10 / %15 / %20 / %25 / %30',
        maxLevel: 5,
        effectPerLevel: 5
    }
];

// MUHTAR AHMET - KÖY GÖREVLERİ (Açık Teslimat)
const DEFAULT_QUESTS = [
    {
        id: 'quest_shark',
        title: 'Dev Köpek Balığı Yakalandı !',
        desc: 'Akdeniz sularında balıkçı teknelerine dehşet saçan dev köpek balıklarının sayısı arttı. 50 adet teslim ederek denizi arındır.',
        requiredItem: 'fish_giant_shark',
        requiredCount: 50,
        rewardItem: 'item_dead_sailor_treasure',
        rewardCount: 5
    },
    {
        id: 'quest_manta',
        title: 'Dev Manta Kaçıyor.',
        desc: 'Okyanusun derinliklerinde ağları parçalayan dev mantalar kaçmadan önce yakalanmalı. 50 adet teslim et ve ödülünü al.',
        requiredItem: 'fish_giant_manta',
        requiredCount: 50,
        rewardItem: 'item_dead_sailor_treasure',
        rewardCount: 5
    },
    {
        id: 'quest_oarfish',
        title: 'Dev Kurdele Balığının İntikamı',
        desc: 'Fırtınalı denizlerin efsanesi kurdele balıkları yüzeye vurdu. 40 adet teslim ederek köyün şanını kurtar.',
        requiredItem: 'fish_oarfish',
        requiredCount: 40,
        rewardItem: 'item_dead_sailor_treasure',
        rewardCount: 5
    },
    {
        id: 'quest_bluefin',
        title: 'Kızıl Orkinos\'un Temizlenmesi',
        desc: 'Sürüler halinde kıyılara yaklaşan Kızıl Orkinos balıklarını kontrol altına almak için 30 adet teslim et.',
        requiredItem: 'fish_crimson_tuna',
        requiredCount: 30,
        rewardItem: 'item_dead_sailor_treasure',
        rewardCount: 5
    },
    {
        id: 'quest_bluefin_massacre',
        title: 'Kızıl Orkinos Katliamı !',
        desc: 'Köyün en çetin sınavı! 300 adet Kızıl Orkinos teslim ederek kadim denizlerin en değerli hazinesi olan Parlak İnci\'yi kazan.',
        requiredItem: 'fish_crimson_tuna',
        requiredCount: 300,
        rewardItem: 'item_pearl',
        rewardCount: 1
    }
];

let QUESTS = JSON.parse(JSON.stringify(DEFAULT_QUESTS));

const ITEMS = {
    // --- OLTALAR ---
    rod_bamboo: {
        id: 'rod_bamboo',
        name: 'Bambu Olta',
        type: 'rod',
        typeName: 'Basit Olta',
        desc: 'Klasik esnek bambu olta. Balıkçı Reis tarafından oltasız kalanlara ücretsiz verilir (Alış/Satış: 0 Altın).',
        rodColor: '#d4a373',
        rodTip: '#e9c46a',
        reelColor: '#6c757d',
        luckBonus: 0,
        buyPrice: 0,
        sellPrice: 0
    },
    rod_oak: {
        id: 'rod_oak',
        name: 'Çırak Gürgen Olta',
        type: 'rod',
        typeName: 'Basit Olta',
        desc: 'Sağlam gürgen ağacından yapılmış olta. Nadirlik şansını hafif artırır (+%2 Şans).',
        rodColor: '#99582a',
        rodTip: '#f4a261',
        reelColor: '#adb5bd',
        luckBonus: 2,
        buyPrice: 140,
        sellPrice: 40
    },
    rod_carbon: {
        id: 'rod_carbon',
        name: 'Mavi Kıyı Kamışı',
        type: 'rod',
        typeName: 'Basit Olta',
        desc: 'Hafif mavi olta kamışı. Nadir balık şansını ve yeşil alanı artırır (+%4 Şans).',
        rodColor: '#00b4d8',
        rodTip: '#90e0ef',
        reelColor: '#e0fbfc',
        luckBonus: 4,
        buyPrice: 320,
        sellPrice: 100
    },
    rod_dragon: {
        id: 'rod_dragon',
        name: 'Altın Ejder Oltası',
        type: 'rod',
        typeName: 'Usta Oltası',
        desc: 'Yakut uçlu altın olta. Büyük denizlerin efsanevi balıklarını çeker (+%8 Şans).',
        rodColor: '#ffbe0b',
        rodTip: '#ff006e',
        reelColor: '#fb5607',
        luckBonus: 8,
        buyPrice: 850,
        sellPrice: 250
    },
    rod_burak: {
        id: 'rod_burak',
        name: "Balıkçı Burak'ın Efsunlu Oltası",
        type: 'rod',
        typeName: 'Efsanevi Craft Oltası (SOS)',
        desc: "5 İnci ve 2 Ölü Denizcinin Hazinesi ile Marangoz Çınar'ın tezgâhında dövülmüş efsunlu kadim olta. Oltaya balık vurma süresini %10 kısaltır, Nadir/Efsanevi yakalama şansını %5 artırır, Auto-Hunt'ı %30 hızlandırır.",
        rodColor: '#00f5d4',
        rodTip: '#ffd166',
        reelColor: '#7209b7',
        luckBonus: 5,           // %5 Nadir/Efsanevi şansı artışı (Çarpımsal)
        speedBonus: 10,         // %10 Oltaya vurma süresi kısaltması
        autoHuntSpeedBonus: 30, // %30 Auto-Hunt hızlandırması
        isSOS: true,
        buyPrice: 0,
        sellPrice: 1500
    },

    // --- YEMLER ---
    bait_worm: {
        id: 'bait_worm',
        name: 'Toprak Solucanı',
        type: 'bait',
        typeName: 'Balık Yemi',
        desc: 'Göl ve deniz balıklarının sevdiği klasik doğal yem (+%2 Şans).',
        baitBonus: 2,
        buyPrice: 8
    },
    bait_shrimp: {
        id: 'bait_shrimp',
        name: 'Parlak Karides Yemi',
        type: 'bait',
        typeName: 'Balık Yemi',
        desc: 'Fosforlu karides. Nadir ve Destansı balıkların dikkatini çeker (+%6 Şans).',
        baitBonus: 6,
        buyPrice: 22
    },
    bait_caviar: {
        id: 'bait_caviar',
        name: 'Altın Havyar Yemi',
        type: 'bait',
        typeName: 'Özel Yem',
        desc: 'Efsanevi balıkların kokusuna dayanamayacağı özel yem (+%12 Şans).',
        baitBonus: 12,
        buyPrice: 55
    },

    // --- EFSUN KAĞITLARI ---
    scroll_luck: {
        id: 'scroll_luck',
        name: 'Kader Efsun Kağıdı (Şans)',
        type: 'scroll',
        typeName: 'Efsun Kağıdı',
        desc: 'Anvil\'de oltaya basıldığında Nadir/Efsanevi balık yakalama şansını +%4 artırır.',
        scrollStat: 'luck',
        scrollValue: 4,
        scrollColor: '#ffbe0b',
        buyPrice: 120
    },
    scroll_speed: {
        id: 'scroll_speed',
        name: 'Çevik Akıntı Kağıdı (Hız)',
        type: 'scroll',
        typeName: 'Efsun Kağıdı',
        desc: 'Anvil\'de oltaya basıldığında balığın oltaya vurma süresini -%6 kısaltır.',
        scrollStat: 'speed',
        scrollValue: 6,
        scrollColor: '#4cc9f0',
        buyPrice: 110
    },
    scroll_control: {
        id: 'scroll_control',
        name: 'Dingin Su Kağıdı (Kontrol)',
        type: 'scroll',
        typeName: 'Efsun Kağıdı',
        desc: 'Anvil\'de oltaya basıldığında barın sağa-sola hareket hızını -%6 yavaşlatır.',
        scrollStat: 'control',
        scrollValue: 6,
        scrollColor: '#80ed99',
        buyPrice: 130
    },
    scroll_protection: {
        id: 'scroll_protection',
        name: 'Kaybolma Koruması Parşömeni',
        type: 'protect_scroll',
        typeName: 'Kadim Koruma Parşömeni',
        desc: 'Anvil\'de artı basarken koruma slotuna koyulduğunda, yükseltme başarısız olsa bile oltanın silinmesini engeller! Başarısızlık durumunda parşömen harcanır ve olta +0\'a düşer. Yükseltme başarılı olursa parşömen harcanmaz.',
        scrollColor: '#7209b7',
        accentColor: '#00f5d4',
        buyPrice: 0,
        sellPrice: 250
    },

    // --- KOSTÜMLER (BAŞLANGIÇ & ÖRS İLE +5 GÜÇLENDİRİLEBİLİR) ---
    costume_fisher: {
        id: 'costume_fisher',
        name: 'Hasır Şapkalı Balıkçı',
        type: 'costume',
        typeName: 'Kostüm',
        desc: 'Güneşten koruyan hasır şapka ve rahat mavi sahil yeleği. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#3a86ff',
        vest: '#8c6239',
        pants: '#2b2d42',
        hat: 'straw',
        buyPrice: 150,
        sellPrice: 50
    },
    costume_pirate: {
        id: 'costume_pirate',
        name: 'Korsan Kaptan Kostümü',
        type: 'costume',
        typeName: 'Korsan Kostümü',
        desc: 'Yedi denizlerin hakimi kırmızı kaptan ceketi ve korsan şapkası. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#d90429',
        vest: '#ffb703',
        pants: '#1d1e2c',
        hat: 'pirate',
        buyPrice: 250,
        sellPrice: 80
    },
    costume_explorer: {
        id: 'costume_explorer',
        name: 'Kutup Kaşifi Parkası',
        type: 'costume',
        typeName: 'Kostüm',
        desc: 'Rüzgarlı deniz kıyıları için turkuaz kürklü su geçirmez kostüm. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#2ec4b6',
        vest: '#cbf3f0',
        pants: '#264653',
        hat: 'hood',
        buyPrice: 350,
        sellPrice: 100
    },

    // --- KOSTÜMCÜ SELİM'İN YENİ BALIKÇI & KORSAN KOSTÜMLERİ ---
    costume_sea_dog: {
        id: 'costume_sea_dog',
        name: 'Deniz Kurdu Kıyafeti',
        type: 'costume',
        typeName: 'Balıkçı Kostümü',
        desc: 'Azgın dalgalarla boğuşmuş emektar bir denizcinin yıpranmaz lacivert süveteri ve denizci beresi. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#1d3557',
        vest: '#457b9d',
        pants: '#2b2d42',
        hat: 'sailor',
        buyPrice: 500,
        sellPrice: 150
    },
    costume_buccaneer: {
        id: 'costume_buccaneer',
        name: 'Karayip Yağmacısı',
        type: 'costume',
        typeName: 'Korsan Kostümü',
        desc: 'Karanlık sularda korku salan korsanların giydiği meşin yelek, altın tokalı kemer ve korsan bandanası. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#3d0c02',
        vest: '#9d0208',
        pants: '#1a1a24',
        hat: 'bandana',
        buyPrice: 750,
        sellPrice: 225
    },
    costume_deep_diver: {
        id: 'costume_deep_diver',
        name: 'Derin Su Dalgıcı',
        type: 'costume',
        typeName: 'Dalgıç Kostümü',
        desc: 'Okyanusun en derin çukurlarındaki antik batıklara inebilmek için pirinç detaylı ve cam başlıklı dalgıç tulumu. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#2b9348',
        vest: '#d4a373',
        pants: '#1b4332',
        hat: 'diving',
        buyPrice: 1200,
        sellPrice: 360
    },
    costume_corsair: {
        id: 'costume_corsair',
        name: 'Barbaros Korsan Zırhı',
        type: 'costume',
        typeName: 'Korsan Kaptan Zırhı',
        desc: 'Kızıl kadife ceket, sırmalı omuzluklar ve tüylü korsan şapkasıyla donatılmış heybetli bir kaptan üniforması. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#6a040f',
        vest: '#ffb703',
        pants: '#03071e',
        hat: 'feather_pirate',
        buyPrice: 2000,
        sellPrice: 600
    },
    costume_master_angler: {
        id: 'costume_master_angler',
        name: 'Usta Olta Balıkçısı',
        type: 'costume',
        typeName: 'Usta Balıkçı Kostümü',
        desc: 'Ceplerinde özel yapay sinekler ve iğneler bulunan haki balıkçı yeleği ve güneş korumalı safari şapkası. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#588157',
        vest: '#a3b18b',
        pants: '#344e41',
        hat: 'bucket',
        buyPrice: 3000,
        sellPrice: 900
    },

    // --- EFSANEVİ OKYANUS DROPU: KRALİYET MUHAFIZI KOSTÜMÜ ---
    costume_royal_guard: {
        id: 'costume_royal_guard',
        name: 'Kraliyet Muhafızı Kostümü',
        type: 'costume',
        typeName: 'Efsanevi Kraliyet Kostümü',
        desc: 'Işıl ışıl parıldayan saf altın ve kraliyet safiriyle örülü efsanevi zırh. Okyanus derinliklerinden (%0.01) drop olur. Giydiğinde etrafına göz alıcı parlama efekti ve kraliyet aurası yayar. Efsunlu Örs\'te +5\'e kadar güçlendirilebilir.',
        shirt: '#1e3d59',
        vest: '#ffd166',
        pants: '#0f172a',
        hat: 'royal_helm',
        isRoyal: true,
        isSOS: true,
        glowColor: '#ffd166',
        // Özel Nitelikler
        rareFishBonus: 5,         // %5 Değerli Balık Tutma Şansı
        fishSpeedBonus: 10,       // %10 Balık Tutma Hızı (Süre kısalması)
        autoHuntSpeedBonus: 10,   // %10 Auto Hunt Hızlandırma
        baitProtectBonus: 20,     // %20 Balık Yemi Koruma Şansı
        buffDurationBonus: 20,    // %20 Yemek Buff Süresi Uzatma
        anvilBonus: 5,            // %5 Anvil şansı
        gamblerBonus: 5,          // %5 Bahisçi Bülo şansı
        buyPrice: 0,
        sellPrice: 5000
    },

    // --- CRAFT MALZEMELERİ (İNCİ & ÖLÜ DENİZCİNİN HAZİNESİ) ---
    item_pearl: {
        id: 'item_pearl',
        name: 'İnci',
        type: 'material',
        typeName: 'Craft Malzemesi (Nadir)',
        desc: 'Derin suların istiridyelerinden çıkan saf parlak inci. İleride özel Olta Craft\'ında kullanılacak! (Drop: %0.5)',
        matColor: '#f8edeb',
        matAccent: '#90e0ef',
        buyPrice: 0,
        sellPrice: 500
    },
    item_dead_sailor_treasure: {
        id: 'item_dead_sailor_treasure',
        name: 'Ölü Denizcinin Hazinesi',
        type: 'material',
        typeName: 'Craft Malzemesi (Efsanevi)',
        desc: 'Okyanus tabanından oltaya takılan kadim denizci sandığı. İleride üst düzey Craft yapımında kullanılacak! (Drop: %1)',
        matColor: '#ffbe0b',
        matAccent: '#9b5de5',
        buyPrice: 0,
        sellPrice: 400
    },
    item_pirate_treasure: {
        id: 'item_pirate_treasure',
        name: 'Korsan Hazinesi',
        type: 'material',
        typeName: 'Efsanevi Hazine (Sarı Bölge)',
        desc: "Sadece Akdeniz'deki Sarı Bereket Bölgesi içerisindeyken %0.1 ihtimalle düşen kadim korsan sandığı. Tersane Kaptanı Barbaros'tan Minnkota'lı Balıkçı Teknesi satın almak için 10 adet gereklidir.",
        matColor: '#ffd166',
        matAccent: '#d90429',
        buyPrice: 0,
        sellPrice: 2000
    },
    item_kraken_shell: {
        id: 'item_kraken_shell',
        name: 'Kraken Kabuğu',
        type: 'material',
        typeName: 'Efsanevi Canavar Zırhı',
        desc: "Kraken Haritası'nın (Kızıl Okyanus) kanlı derinliklerinden çıkarılan sert, obsidyen-kızıl zırh kabuğu. Sadece Kraken Bölgesinden drop olur. Kadim lonca eşyaları ve efsunlar için kullanılır.",
        matColor: '#2b070c',
        matAccent: '#ef4444',
        buyPrice: 0,
        sellPrice: 1500
    },

    // --- ÇİĞ BALIKLAR (BURNAZ GÖL & DENİZ) ---
    fish_perch: {
        id: 'fish_perch',
        name: 'Çizgili Tatlısu Levreği',
        type: 'fish',
        habitat: 'lake',
        rarityKey: 'COMMON',
        typeName: 'Göl Balığı (Sıradan)',
        desc: 'Burnaz Sahil gölünde sıkça rastlanan lezzetli tatlısu balığı.',
        rarity: RARITY.COMMON,
        fishColor: '#7ae582',
        finColor: '#ff9f1c',
        buyPrice: 0,
        sellPrice: 25
    },
    fish_carp: {
        id: 'fish_carp',
        name: 'Altın Sazan',
        type: 'fish',
        habitat: 'lake',
        rarityKey: 'UNCOMMON',
        typeName: 'Göl Balığı (Gelişmiş)',
        desc: 'Sazlıkların arasında saklanan parlak pullu göl sazanı.',
        rarity: RARITY.UNCOMMON,
        fishColor: '#f77f00',
        finColor: '#fcbf49',
        buyPrice: 0,
        sellPrice: 55
    },
    fish_koi: {
        id: 'fish_koi',
        name: 'İmparator Koi',
        type: 'fish',
        habitat: 'lake',
        rarityKey: 'RARE',
        typeName: 'Göl Balığı (Nadir)',
        desc: 'Kırmızı-beyaz desenli çok değerli bir göl balığı.',
        rarity: RARITY.RARE,
        fishColor: '#ef233c',
        finColor: '#edf2f4',
        buyPrice: 0,
        sellPrice: 120
    },
    fish_catfish: {
        id: 'fish_catfish',
        name: 'Dev Göl Yayın Balığı',
        type: 'fish',
        habitat: 'lake',
        rarityKey: 'EPIC',
        typeName: 'Göl Balığı (Destansı)',
        desc: 'Gölün en derin çukurunda yaşayan bıyıklı dev yayın balığı.',
        rarity: RARITY.EPIC,
        fishColor: '#7209b7',
        finColor: '#4cc9f0',
        buyPrice: 0,
        sellPrice: 240
    },
    fish_sardine: {
        id: 'fish_sardine',
        name: 'Gümüş Sardalya',
        type: 'fish',
        habitat: 'sea',
        rarityKey: 'COMMON',
        typeName: 'Deniz Balığı (Sıradan)',
        desc: 'Burnaz Sahil kıyısında sürüler halinde gezen parlak deniz balığı.',
        rarity: RARITY.COMMON,
        fishColor: '#90e0ef',
        finColor: '#0077b6',
        buyPrice: 0,
        sellPrice: 30
    },
    fish_bream: {
        id: 'fish_bream',
        name: 'Kraliyet Çipurası',
        type: 'fish',
        habitat: 'sea',
        rarityKey: 'UNCOMMON',
        typeName: 'Deniz Balığı (Gelişmiş)',
        desc: 'İskele yakınlarında avlanan sert pullu deniz çipurası.',
        rarity: RARITY.UNCOMMON,
        fishColor: '#48cae4',
        finColor: '#ffb703',
        buyPrice: 0,
        sellPrice: 65
    },
    fish_swordfish: {
        id: 'fish_swordfish',
        name: 'Mavi Kılıç Balığı',
        type: 'fish',
        habitat: 'sea',
        rarityKey: 'RARE',
        typeName: 'Deniz Balığı (Nadir)',
        desc: 'Uzun ve keskin gagasıyla çok hızlı hareket eden açık deniz avcısı.',
        rarity: RARITY.RARE,
        fishColor: '#0096c7',
        finColor: '#caf0f8',
        buyPrice: 0,
        sellPrice: 135
    },
    fish_tuna: {
        id: 'fish_tuna',
        name: 'Kızıl Yüzgeçli Orkinos',
        type: 'fish',
        habitat: 'sea',
        rarityKey: 'EPIC',
        typeName: 'Deniz Balığı (Destansı)',
        desc: 'Oltayı kırma noktasına getiren devasa okyanus orkinosu.',
        rarity: RARITY.EPIC,
        fishColor: '#9b5de5',
        finColor: '#f15bb5',
        buyPrice: 0,
        sellPrice: 270
    },
    fish_leviathan: {
        id: 'fish_leviathan',
        name: 'Kristal Deniz Ejderi',
        type: 'fish',
        habitat: 'both',
        rarityKey: 'LEGENDARY',
        typeName: 'Efsanevi Balık',
        desc: 'Sadece en usta balıkçıların yakalayabildiği parıldayan efsanevi balık!',
        rarity: RARITY.LEGENDARY,
        fishColor: '#ffbe0b',
        finColor: '#ff006e',
        buyPrice: 0,
        sellPrice: 600
    },

    // --- AKDENİZ (OKYANUS HARİTASI) ÖZEL BALIKLARI ---
    fish_glass_shark: {
        id: 'fish_glass_shark',
        name: 'Cam Göz',
        type: 'fish',
        habitat: 'ocean',
        rarityKey: 'COMMON',
        typeName: 'Okyanus Balığı (Sıradan)',
        desc: 'Akdeniz açıklarında sürü halinde dolaşan parlak gözlü açık deniz köpek balığı türü.',
        rarity: RARITY.COMMON,
        fishColor: '#8ecae6',
        finColor: '#219ebc',
        buyPrice: 0,
        sellPrice: 65
    },
    fish_giant_manta: {
        id: 'fish_giant_manta',
        name: 'Dev Manta',
        type: 'fish',
        habitat: 'ocean',
        rarityKey: 'UNCOMMON',
        typeName: 'Okyanus Balığı (Gelişmiş)',
        desc: 'Devasa kanatlarıyla Akdeniz\'in derin akıntılarında süzülen görkemli vatoz.',
        rarity: RARITY.UNCOMMON,
        fishColor: '#3a0ca3',
        finColor: '#4cc9f0',
        buyPrice: 0,
        sellPrice: 140
    },
    fish_giant_shark: {
        id: 'fish_giant_shark',
        name: 'Dev Köpek Balığı',
        type: 'fish',
        habitat: 'ocean',
        rarityKey: 'RARE',
        typeName: 'Okyanus Balığı (Nadir)',
        desc: 'Akdeniz sularının korkulu rüyası, keskin dişli dev okyanus avcısı.',
        rarity: RARITY.RARE,
        fishColor: '#495057',
        finColor: '#ef233c',
        buyPrice: 0,
        sellPrice: 290
    },
    fish_oarfish: {
        id: 'fish_oarfish',
        name: 'Dev Kurdele Balığı',
        type: 'fish',
        habitat: 'ocean',
        rarityKey: 'EPIC',
        typeName: 'Okyanus Balığı (Destansı)',
        desc: 'Okyanusun en derin katmanlarından yüzeye nadir çıkan gümüş-kızıl yeleli efsanevi uzunluktaki balık.',
        rarity: RARITY.EPIC,
        fishColor: '#e0fbfc',
        finColor: '#ff006e',
        buyPrice: 0,
        sellPrice: 540
    },
    fish_crimson_tuna: {
        id: 'fish_crimson_tuna',
        name: 'Kızıl Orkinos',
        type: 'fish',
        habitat: 'ocean',
        rarityKey: 'LEGENDARY',
        typeName: 'Okyanus Balığı (Efsanevi)',
        desc: 'Akdeniz\'in yakut kırmızısı pullara sahip en değerli ve en güçlü imparator balığı!',
        rarity: RARITY.LEGENDARY,
        fishColor: '#d90429',
        finColor: '#ffbe0b',
        buyPrice: 0,
        sellPrice: 1100
    }
};

function syncCookedFishItems() {
    Object.values(ITEMS).filter(i => i.type === 'fish').forEach(fish => {
        if (fish.rarityKey && RARITY[fish.rarityKey]) {
            fish.rarity = RARITY[fish.rarityKey];
        }
        const r = fish.rarity || RARITY.COMMON;
        const habLabel = fish.habitat === 'lake'
            ? 'Göl Balığı'
            : fish.habitat === 'sea'
            ? 'Deniz Balığı'
            : fish.habitat === 'ocean'
            ? 'Okyanus Balığı'
            : 'Efsanevi Su Balığı';
        fish.typeName = `${habLabel} (${r.name})`;

        const cookedId = `cooked_${fish.id}`;
        ITEMS[cookedId] = {
            id: cookedId,
            name: `Izgara ${fish.name}`,
            type: 'cooked_fish',
            typeName: `Pişmiş Yemek (${r.name})`,
            desc: `Şef Gusto tarafından özenle pişirildi. Yendiğinde: ${r.buffDesc}.`,
            rarity: r,
            fishColor: fish.fishColor,
            finColor: fish.finColor,
            customImage: fish.customImage || null
        };
    });
}
syncCookedFishItems();

// ============================================================================
// 4. OYUNCU DURUMU, SEVİYE, YETENEKLER, TEKNELER, EFSUNLAR & AUTO-HUNT
// ============================================================================
const player = {
    name: SafeStorage.getItem('mmo_character_name') || '',
    guildName: SafeStorage.getItem('mmo_player_guild') || '',
    chatBubble: null,
    x: 13.5,
    y: 11.5,
    dirX: 1,
    dirY: 0,
    speed: 4.2,
    path: [],
    targetMarker: null,
    pendingInteraction: null,
    walkCycle: 0,
    gold: 250,
    // Seviye & EXP Sistemi (Maksimum Lv 10)
    level: 1,
    exp: 0, // 0..100 yüzde
    skillPoints: 0,
    // Satın alınan tekneler (Envantere girmez, kalıcı olarak oyuncuya ait olur)
    ownedBoats: [],
    activeBoatId: 'boat_raft',
    skills: {
        burak_tactics: 0,       // +%2 şans / lv
        talha_luck: 0,          // -%5 balık tutma süresi / lv
        duran_beret: 0,         // -%3 bar hızı / lv
        chef_gusto_mastery: 0,  // +%10 yemek buff süresi / lv (%50 maks)
        carpenter_wisdom: 0,    // +%1 craft malzeme koruma / lv (%5 maks)
        anvil_patron: 0,        // +%1 anvil başarı oranı / lv (%5 maks)
        fisherman_prayer: 0     // yem koruma: %10, %15, %20, %25, %30
    },
    equipped: {
        rod: 'rod_bamboo',
        rodUid: 'init_rod_1',
        bait: 'bait_worm',
        costume: 'costume_fisher',
        costumeUid: 'init_costume_1'
    },
    rodEnchants: {
        rod_bamboo: { count: 0, luck: 0, speed: 0, control: 0 },
        rod_oak:    { count: 0, luck: 0, speed: 0, control: 0 },
        rod_carbon: { count: 0, luck: 0, speed: 0, control: 0 },
        rod_dragon: { count: 0, luck: 0, speed: 0, control: 0 }
    },
    costumeEnchants: (() => {
        try {
            const raw = localStorage.getItem('mmo_costume_enchants');
            return raw ? JSON.parse(raw) : {};
        } catch(e) {
            return {};
        }
    })(),
    buffs: [],
    // Yanlışlıkla satılan eşyaları geri alma (Buyback) listesi
    buybackList: [],
    inventory: [
        { uid: 'init_rod_1', id: 'rod_bamboo', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
        { id: 'bait_worm', count: 15 },
        { uid: 'init_costume_1', id: 'costume_fisher', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
        { uid: 'init_costume_2', id: 'costume_pirate', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
        { uid: 'init_costume_3', id: 'costume_explorer', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
        { id: 'fish_perch', count: 2 },
        { id: 'fish_koi', count: 1 }
    ],
    storage: [
        new Array(24).fill(null),
        new Array(24).fill(null)
    ],
    activeStoragePage: 0
};

// Anvil (Efsunlu Örs) Durumu - Otomatik olta veya kostüm seçmez, oyuncu envanterden koyar!
const anvilState = {
    rodUid: null,
    itemUid: null,
    scrollId: null,
    protectScrollId: null,
    isForging: false
};

// Bahisçi Bülo (Hazine Masası) Durumu
const gamblerState = {
    treasurePlaced: false,
    isOpening: false
};

// Auto-Hunt (O Tuşu - AFK Farmer Modu)
const autoHunt = {
    active: false,
    caughtCount: 0,
    cooldownTimer: 0,
    navigatingToHotspot: false
};

function getEquippedRodEntry() {
    if (!player.equipped.rod) return null;
    if (player.equipped.rodUid) {
        const byUid = player.inventory.find(e => e.uid === player.equipped.rodUid);
        if (byUid) return byUid;
    }
    return player.inventory.find(e => e.id === player.equipped.rod) || null;
}

function getEquippedCostumeEntry() {
    if (!player.equipped.costume) return null;
    if (player.equipped.costumeUid) {
        const byUid = player.inventory.find(e => e.uid === player.equipped.costumeUid);
        if (byUid) return byUid;
    }
    return player.inventory.find(e => e.id === player.equipped.costume) || null;
}

function getEquippedCostumeItem() {
    return player.equipped.costume ? ITEMS[player.equipped.costume] : null;
}

function getEntryEnchants(entry) {
    if (!entry) return { count: 0, luck: 0, speed: 0, control: 0 };
    if (entry.enchants) return entry.enchants;
    const it = ITEMS[entry.id];
    if (it && it.type === 'costume') {
        player.costumeEnchants = player.costumeEnchants || {};
        if (!player.costumeEnchants[entry.id]) {
            player.costumeEnchants[entry.id] = { count: 0, luck: 0, speed: 0, control: 0 };
        }
        entry.enchants = { ...player.costumeEnchants[entry.id] };
        return entry.enchants;
    }
    return player.rodEnchants[entry.id] || { count: 0, luck: 0, speed: 0, control: 0 };
}

// Oyuncunun toplam balıkçılık bonuslarını hesapla (Olta + Kostüm + Efsunlar + Yem + Yemek Buff + Pasif Yetenekler)
function getPlayerFishingStats() {
    let luckPct = 0;    // Nadirlik şansı artışı (%)
    let speedPct = 0;   // Balık tutma süresinde kısalma (%)
    let barSlowPct = 0; // Barın hareket hızında yavaşlama (%)

    // 1. Pasif Yetenekler (K Ağacı)
    const sk0 = PASSIVE_SKILLS.find(s => s.id === 'burak_tactics');
    const sk1 = PASSIVE_SKILLS.find(s => s.id === 'talha_luck');
    const sk2 = PASSIVE_SKILLS.find(s => s.id === 'duran_beret');
    luckPct    += (player.skills.burak_tactics || 0) * (sk0 ? sk0.effectPerLevel : 2);
    speedPct   += (player.skills.talha_luck || 0)    * (sk1 ? sk1.effectPerLevel : 5);
    barSlowPct += (player.skills.duran_beret || 0)   * (sk2 ? sk2.effectPerLevel : 3);

    // 2. Olta ve Olta Efsunları
    if (player.equipped.rod) {
        const rod = ITEMS[player.equipped.rod];
        if (rod) {
            if (rod.luckBonus) luckPct += rod.luckBonus;
            if (rod.speedBonus) speedPct += rod.speedBonus;
        }
        const rodEntry = getEquippedRodEntry();
        const ench = getEntryEnchants(rodEntry);
        if (ench) {
            luckPct += ench.luck;
            speedPct += ench.speed;
            barSlowPct += ench.control;
        }
    }

    // 2.5 Kostüm Temel Nitelikleri ve Kostüm Efsunları (+1..+5)
    const costumeItem = getEquippedCostumeItem();
    if (costumeItem) {
        if (costumeItem.rareFishBonus) luckPct += costumeItem.rareFishBonus;
        if (costumeItem.fishSpeedBonus) speedPct += costumeItem.fishSpeedBonus;
    }
    const costumeEntry = getEquippedCostumeEntry();
    if (costumeEntry) {
        const cEnch = getEntryEnchants(costumeEntry);
        if (cEnch) {
            luckPct += (cEnch.luck || 0);
            speedPct += (cEnch.speed || 0);
            barSlowPct += (cEnch.control || 0);
        }
    }

    // 3. Yem
    if (player.equipped.bait) {
        const bait = ITEMS[player.equipped.bait];
        if (bait && bait.baitBonus) luckPct += bait.baitBonus;
    }

    // 4. Şef'in Yemek Buffları
    player.buffs.forEach(b => {
        if (b.type === 'luck') luckPct += b.val;
        if (b.type === 'speed') speedPct += b.val;
        if (b.type === 'control') {
            barSlowPct += b.val;
            luckPct += 3;
        }
    });

    return {
        luckPct: Math.min(120, luckPct),
        speedPct: Math.min(70, speedPct),
        barSlowPct: Math.min(65, barSlowPct)
    };
}

// Seviye ve EXP Kazanımı (1 - 20)
const LEVEL_TITLES = [
    '',
    'Sahil Çırağı',                 // 1
    'Amatör Olta Balıkçısı',        // 2
    'Göl Avcısı',                   // 3
    'Kıyı Ustası',                  // 4
    'Deniz Kurdu',                  // 5
    'Derin Su Kaşifi',              // 6
    'Usta Balıkçı',                 // 7
    'Okyanus Efendisi',             // 8
    'Burnaz Efsanesi',              // 9
    'Kadim Denizler Hakimi',        // 10
    'Fırtına Süvarisi',             // 11
    'Akdeniz Fatihi',               // 12
    'Derin Uçurum Avcısı',          // 13
    'Poseidon’un Elçisi',           // 14
    'Canavar Terbiyecisi',          // 15
    'Sonsuz Mavi Hakimi',           // 16
    'Girdap Hükümdarı',             // 17
    'Kayıp Atlantis Kaşifi',        // 18
    'Mitolojik Deniz Tanrısı',      // 19
    'Yüce Okyanus İmparatoru (MAX)'  // 20
];

function gainExp(amountPct) {
    if (player.level >= MAX_PLAYER_LEVEL) {
        player.exp = 100;
        updateExpHUD();
        return;
    }

    player.exp += amountPct;
    while (player.exp >= 100 && player.level < MAX_PLAYER_LEVEL) {
        player.exp -= 100;
        player.level += 1;
        player.skillPoints += 1;
        showToast(`🎉 SEVİYE ATLADIN! Lv. ${player.level} oldun ve +1 Yetenek Puanı kazandın! (K tuşu ile kullan)`, '#ffbe0b');
    }

    if (player.level >= MAX_PLAYER_LEVEL) {
        player.exp = 100;
    }
    updateExpHUD();
}

function updateExpHUD() {
    document.getElementById('exp-level-badge').textContent = `Lv. ${player.level}`;
    const pTitle = LEVEL_TITLES[player.level] || 'Balıkçı';
    document.getElementById('exp-title-text').textContent = player.name ? `${player.name} (${pTitle})` : pTitle;
    const pctText = player.level >= MAX_PLAYER_LEVEL ? 'MAKSİMUM SEVİYE (%100)' : `EXP: %${player.exp} / %100`;
    document.getElementById('exp-percent-text').textContent = pctText;
    document.getElementById('exp-bar-fill').style.width = `${Math.min(100, player.exp)}%`;

    const spBadge = document.getElementById('hud-sp-badge');
    if (player.skillPoints > 0) {
        spBadge.textContent = `${player.skillPoints} Puan!`;
        spBadge.classList.remove('hidden');
    } else {
        spBadge.classList.add('hidden');
    }
}
updateExpHUD();

function updateGoldHUD() {
    document.getElementById('hud-gold').textContent = player.gold;
}
updateGoldHUD();
renderBuffBar();

function showToast(msg, borderColor = '#d4a373') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.borderColor = borderColor;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.3s';
        setTimeout(() => el.remove(), 300);
    }, 3200);
}

// Silkroad Online SOS 4 Köşeli Parlayan Yıldız Çizici (Kanvas ve Karakter İçin)
function drawSilkroadSparkle(g, cx, cy, r, color = '#ffd166') {
    g.save();
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.quadraticCurveTo(cx, cy, cx + r, cy);
    g.quadraticCurveTo(cx, cy, cx, cy + r);
    g.quadraticCurveTo(cx, cy, cx - r, cy);
    g.quadraticCurveTo(cx, cy, cx, cy - r);
    g.fill();

    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx, cy, Math.max(0.6, r * 0.35), 0, Math.PI * 2);
    g.fill();
    g.restore();
}

// ============================================================================
// 5. EŞYA İKON ÇİZİCİ (Özel Görsel veya Vektörel Çizim)
// ============================================================================
function createItemIconCanvas(item) {
    const c = document.createElement('canvas');
    c.width = 48;
    c.height = 48;
    const g = c.getContext('2d');

    // Eğer Kontrol Panelinden özel bir görsel (PNG/JPG/URL) atanmışsa onu çiz!
    if (item.customImage) {
        const img = getCustomImageObj(item.customImage);
        if (img && img.complete && img.naturalWidth > 0) {
            if (item.type === 'cooked_fish') {
                g.fillStyle = 'rgba(255, 159, 28, 0.32)';
                g.beginPath();
                g.arc(24, 24, 20, 0, Math.PI * 2);
                g.fill();
            }
            g.drawImage(img, 4, 4, 40, 40);
            return c;
        } else if (img) {
            img.onload = () => {
                g.clearRect(0, 0, 48, 48);
                g.drawImage(img, 4, 4, 40, 40);
            };
        }
    }

    if (item.type === 'rod') {
        if (item.isSOS) {
            // SOS Parlama Arka Plan Halesi
            g.fillStyle = 'rgba(0, 245, 212, 0.22)';
            g.beginPath();
            g.arc(24, 24, 21, 0, Math.PI * 2);
            g.fill();

            // Parlayan Silkroad SOS Yıldızları
            drawSilkroadSparkle(g, 15, 15, 4.5, '#ffd166');
            drawSilkroadSparkle(g, 35, 27, 3.6, '#00f5d4');
            drawSilkroadSparkle(g, 26, 39, 2.8, '#ffffff');
        }

        g.strokeStyle = item.rodColor;
        g.lineWidth = 4;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(10, 38);
        g.quadraticCurveTo(24, 22, 38, 10);
        g.stroke();

        if (item.isSOS) {
            g.strokeStyle = '#ffd166';
            g.lineWidth = 1.8;
            g.stroke();
        }

        g.strokeStyle = '#343a40';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(8, 40);
        g.lineTo(15, 33);
        g.stroke();

        g.fillStyle = item.reelColor;
        g.beginPath();
        g.arc(18, 32, 4.5, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = item.rodTip;
        g.beginPath();
        g.arc(38, 10, item.isSOS ? 4 : 3, 0, Math.PI * 2);
        g.fill();

        g.strokeStyle = 'rgba(255,255,255,0.75)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(38, 11);
        g.lineTo(38, 29);
        g.stroke();

        g.fillStyle = '#ef233c';
        g.beginPath();
        g.arc(38, 31, 3.5, 0, Math.PI * 2);
        g.fill();
    } else if (item.type === 'bait') {
        if (item.id === 'bait_worm') {
            g.strokeStyle = '#e56b6f';
            g.lineWidth = 5;
            g.lineCap = 'round';
            g.beginPath();
            g.moveTo(12, 34);
            g.bezierCurveTo(18, 18, 28, 32, 36, 14);
            g.stroke();
        } else if (item.id === 'bait_shrimp') {
            g.strokeStyle = '#ff9f1c';
            g.lineWidth = 6;
            g.lineCap = 'round';
            g.beginPath();
            g.arc(24, 24, 10, 0.2, Math.PI * 1.35);
            g.stroke();
            g.fillStyle = '#000';
            g.beginPath();
            g.arc(31, 18, 1.5, 0, Math.PI * 2);
            g.fill();
        } else {
            const dots = [[20, 26], [27, 26], [24, 20], [19, 21], [28, 21], [24, 30]];
            dots.forEach(([dx, dy]) => {
                g.fillStyle = '#ffbe0b';
                g.beginPath();
                g.arc(dx, dy, 4.5, 0, Math.PI * 2);
                g.fill();
                g.fillStyle = '#fff3b0';
                g.beginPath();
                g.arc(dx - 1.5, dy - 1.5, 1.5, 0, Math.PI * 2);
                g.fill();
            });
        }
    } else if (item.type === 'scroll' || item.type === 'protect_scroll') {
        if (item.type === 'protect_scroll' || item.id === 'scroll_protection') {
            // Kadim Koruma Parşömeni (Koyu Mor ve Camgöbeği Kalkan / Tılsım)
            g.fillStyle = 'rgba(0, 245, 212, 0.22)';
            g.beginPath();
            g.arc(24, 24, 21, 0, Math.PI * 2);
            g.fill();

            g.fillStyle = '#240046';
            g.fillRect(13, 10, 22, 28);
            g.fillStyle = '#ffd166';
            g.fillRect(10, 8, 28, 4);
            g.fillRect(10, 36, 28, 4);

            // Koruma Kalkanı Rünü
            g.fillStyle = '#00f5d4';
            g.beginPath();
            g.moveTo(24, 16);
            g.lineTo(31, 20);
            g.lineTo(31, 26);
            g.quadraticCurveTo(24, 32, 24, 33);
            g.quadraticCurveTo(24, 32, 17, 26);
            g.lineTo(17, 20);
            g.closePath();
            g.fill();

            // Kalkanın ortasında altın yıldız
            drawSilkroadSparkle(g, 24, 23, 2.5, '#ffd166');
        } else {
            g.fillStyle = '#f3e5ab';
            g.fillRect(13, 10, 22, 28);
            g.fillStyle = '#c89b6e';
            g.fillRect(10, 8, 28, 4);
            g.fillRect(10, 36, 28, 4);
            g.fillStyle = item.scrollColor;
            g.beginPath();
            g.arc(24, 24, 6, 0, Math.PI * 2);
            g.fill();
        }
    } else if (item.type === 'costume') {
        if (item.isRoyal || item.isSOS || item.id === 'costume_royal_guard') {
            // Kraliyet Işıltılı Arka Plan Halesi & Safir Yıldızlar
            const grad = g.createRadialGradient(24, 24, 4, 24, 24, 22);
            grad.addColorStop(0, 'rgba(255, 209, 102, 0.45)');
            grad.addColorStop(0.7, 'rgba(0, 245, 212, 0.25)');
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            g.fillStyle = grad;
            g.beginPath();
            g.arc(24, 24, 22, 0, Math.PI * 2);
            g.fill();
        }

        g.fillStyle = item.shirt || '#1d3557';
        g.beginPath();
        g.roundRect(12, 18, 24, 20, 5);
        g.fill();

        g.fillStyle = item.vest || '#ffd166';
        g.fillRect(16, 18, 6, 20);
        g.fillRect(26, 18, 6, 20);

        // Şapka / Miğfer İkonu
        if (item.hat === 'royal_helm') {
            g.fillStyle = '#ffd166';
            g.beginPath();
            g.arc(24, 13, 8, Math.PI, 0);
            g.fill();
            g.fillStyle = '#00f5d4';
            g.beginPath();
            g.arc(24, 11, 2.5, 0, Math.PI * 2);
            g.fill();
        } else if (item.hat === 'pirate' || item.hat === 'feather_pirate') {
            g.fillStyle = '#1d1e2c';
            g.beginPath();
            g.moveTo(11, 14);
            g.quadraticCurveTo(24, 6, 37, 14);
            g.closePath();
            g.fill();
            g.fillStyle = '#ffbe0b';
            g.beginPath();
            g.arc(24, 11, 2, 0, Math.PI * 2);
            g.fill();
        } else if (item.hat === 'bandana') {
            g.fillStyle = '#9d0208';
            g.beginPath();
            g.arc(24, 13, 7.5, Math.PI, 0);
            g.fill();
        } else if (item.hat === 'diving') {
            g.fillStyle = '#d4a373';
            g.beginPath();
            g.arc(24, 13, 8, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = '#a2d2ff';
            g.beginPath();
            g.arc(24, 13, 3.5, 0, Math.PI * 2);
            g.fill();
        } else {
            g.fillStyle = '#ffd166';
            g.beginPath();
            g.arc(24, 12, 7, Math.PI, 0);
            g.fill();
        }

        if (item.isRoyal || item.isSOS || item.id === 'costume_royal_guard') {
            drawSilkroadSparkle(g, 10, 12, 2.5, '#ffd166');
            drawSilkroadSparkle(g, 38, 12, 2.5, '#00f5d4');
            drawSilkroadSparkle(g, 24, 32, 2.0, '#ffffff');
        }
    } else if (item.type === 'material') {
        if (item.id === 'item_pearl') {
            // İstiridye kabuğu içinde parlayan İnci
            g.fillStyle = item.matAccent || '#90e0ef';
            g.beginPath();
            g.ellipse(24, 30, 15, 9, 0, 0, Math.PI * 2);
            g.fill();

            g.fillStyle = '#48cae4';
            g.beginPath();
            g.arc(24, 20, 13, Math.PI, 0);
            g.fill();

            // Parlayan İnci Küresi
            const grad = g.createRadialGradient(22, 23, 2, 24, 25, 8);
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(0.6, item.matColor || '#f8edeb');
            grad.addColorStop(1, '#adb5bd');
            g.fillStyle = grad;
            g.beginPath();
            g.arc(24, 25, 7.5, 0, Math.PI * 2);
            g.fill();
        } else if (item.id === 'item_kraken_shell') {
            // Kraken Kabuğu: Obsidyen-Kızıl Dikenli Kabuk Zırhı
            g.fillStyle = 'rgba(239, 68, 68, 0.25)';
            g.beginPath();
            g.arc(24, 24, 20, 0, Math.PI * 2);
            g.fill();

            // Kabuk katmanları
            g.fillStyle = '#2b070c';
            g.beginPath();
            g.moveTo(24, 6);
            g.lineTo(38, 16);
            g.lineTo(34, 38);
            g.lineTo(24, 42);
            g.lineTo(14, 38);
            g.lineTo(10, 16);
            g.closePath();
            g.fill();
            g.strokeStyle = '#ef4444';
            g.lineWidth = 2;
            g.stroke();

            // İç plaka ve dikenler
            g.fillStyle = '#4a0e17';
            g.beginPath();
            g.moveTo(24, 12);
            g.lineTo(32, 20);
            g.lineTo(28, 34);
            g.lineTo(24, 37);
            g.lineTo(20, 34);
            g.lineTo(16, 20);
            g.closePath();
            g.fill();

            // Kızıl enerji çatlakları
            g.strokeStyle = '#f87171';
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(24, 12); g.lineTo(24, 37);
            g.moveTo(16, 24); g.lineTo(32, 24);
            g.stroke();

            // Yan sivri mahmuz dikenleri
            g.fillStyle = '#991b1b';
            g.beginPath();
            g.moveTo(8, 22); g.lineTo(12, 17); g.lineTo(12, 27); g.closePath(); g.fill();
            g.moveTo(40, 22); g.lineTo(36, 17); g.lineTo(36, 27); g.closePath(); g.fill();

            // Parlayan merkez çekirdek
            g.fillStyle = '#ffd166';
            g.beginPath();
            g.arc(24, 24, 3.5, 0, Math.PI * 2);
            g.fill();
            drawSilkroadSparkle(g, 24, 24, 2.0, '#ffffff');
        } else if (item.id === 'item_pirate_treasure') {
            // Korsan Hazinesi (Karanlık Abanoz & Altın Kenarlı Efsanevi Sandık)
            g.fillStyle = 'rgba(255, 190, 11, 0.25)';
            g.beginPath();
            g.arc(24, 24, 20, 0, Math.PI * 2);
            g.fill();

            // Sandık gövdesi (Koyu Maun)
            g.fillStyle = '#1f130b';
            g.beginPath();
            g.roundRect(8, 17, 32, 22, 4);
            g.fill();

            // Sandık kapağı
            g.fillStyle = '#2c1810';
            g.beginPath();
            g.roundRect(8, 12, 32, 9, 4);
            g.fill();

            // Altın çerçeve ve şeritler
            g.strokeStyle = '#ffd166';
            g.lineWidth = 2.5;
            g.strokeRect(10, 14, 28, 23);

            // Kırmızı yakut korsan mücevheri
            g.fillStyle = '#d90429';
            g.beginPath();
            g.arc(24, 23, 4, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#ffd166';
            g.lineWidth = 1.5;
            g.stroke();

            // Altın kilit
            g.fillStyle = '#ffd166';
            g.fillRect(22, 28, 4, 6);
        } else {
            // Ölü Denizcinin Hazinesi (Altın Kilitli Kadim Sandık)
            g.fillStyle = '#582f0e';
            g.beginPath();
            g.roundRect(10, 18, 28, 20, 4);
            g.fill();

            g.fillStyle = '#7f4f24';
            g.beginPath();
            g.roundRect(10, 13, 28, 9, 4);
            g.fill();

            g.strokeStyle = item.matColor || '#ffbe0b';
            g.lineWidth = 3;
            g.strokeRect(12, 15, 24, 21);

            g.fillStyle = item.matColor || '#ffbe0b';
            g.fillRect(21, 21, 6, 7);
        }
    } else if (item.type === 'fish' || item.type === 'cooked_fish') {
        if (item.type === 'cooked_fish') {
            g.fillStyle = 'rgba(255, 159, 28, 0.28)';
            g.beginPath();
            g.arc(24, 25, 18, 0, Math.PI * 2);
            g.fill();
        }
        g.fillStyle = item.finColor;
        g.beginPath();
        g.moveTo(12, 24);
        g.lineTo(5, 16);
        g.lineTo(5, 32);
        g.closePath();
        g.fill();

        g.fillStyle = item.type === 'cooked_fish' ? '#d97724' : item.fishColor;
        g.beginPath();
        g.ellipse(25, 24, 13, 8.5, 0, 0, Math.PI * 2);
        g.fill();

        if (item.type === 'cooked_fish') {
            g.strokeStyle = '#582f0e';
            g.lineWidth = 2;
            for (let gx = 19; gx <= 29; gx += 5) {
                g.beginPath();
                g.moveTo(gx, 18);
                g.lineTo(gx - 2, 30);
                g.stroke();
            }
        } else {
            g.fillStyle = '#fff';
            g.beginPath();
            g.arc(32, 22, 2.5, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = '#111';
            g.beginPath();
            g.arc(33, 22, 1.2, 0, Math.PI * 2);
            g.fill();
        }
    }
    return c;
}

// Tekne İkon Çizici (NPC ve GM Paneli İçin)
function createBoatIconCanvas(boat) {
    const c = document.createElement('canvas');
    c.width = 48;
    c.height = 48;
    const g = c.getContext('2d');

    if (boat.customImage) {
        const img = getCustomImageObj(boat.customImage);
        if (img && img.complete && img.naturalWidth > 0) {
            g.drawImage(img, 4, 4, 40, 40);
            return c;
        } else if (img) {
            img.onload = () => {
                g.clearRect(0, 0, 48, 48);
                g.drawImage(img, 4, 4, 40, 40);
            };
        }
    }

    // Su dalgası tabanı
    g.fillStyle = 'rgba(0, 180, 216, 0.35)';
    g.beginPath();
    g.ellipse(24, 36, 18, 6, 0, 0, Math.PI * 2);
    g.fill();

    if (boat.id === 'boat_raft') {
        // Sal (Kütükler ve Yelken Direği)
        g.fillStyle = boat.hullColor || '#8c6239';
        for (let lx = 10; lx <= 34; lx += 6) {
            g.beginPath();
            g.roundRect(lx, 26, 5, 11, 2);
            g.fill();
        }
        g.strokeStyle = boat.accentColor || '#d4a373';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(9, 30); g.lineTo(39, 30);
        g.moveTo(9, 34); g.lineTo(39, 34);
        g.stroke();
    } else if (boat.id === 'boat_boat') {
        // Klasik Tekne
        g.fillStyle = boat.hullColor || '#457b9d';
        g.beginPath();
        g.moveTo(8, 24);
        g.lineTo(40, 24);
        g.lineTo(34, 36);
        g.lineTo(14, 36);
        g.closePath();
        g.fill();

        g.strokeStyle = boat.accentColor || '#f1faee';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(9, 26);
        g.lineTo(39, 26);
        g.stroke();
    } else if (boat.id === 'boat_yacht') {
        // Lüks Yat
        g.fillStyle = boat.hullColor || '#f8f9fa';
        g.beginPath();
        g.moveTo(6, 25);
        g.lineTo(42, 23);
        g.lineTo(36, 36);
        g.lineTo(12, 36);
        g.closePath();
        g.fill();

        g.fillStyle = boat.accentColor || '#00b4d8';
        g.beginPath();
        g.moveTo(15, 24);
        g.lineTo(31, 24);
        g.lineTo(27, 15);
        g.lineTo(18, 15);
        g.closePath();
        g.fill();
    } else if (boat.id === 'boat_minnkota') {
        // Minnkota'lı Balıkçı Teknesi (GPS Otopilot & Neon Cyan Çizgiler)
        g.fillStyle = 'rgba(0, 245, 212, 0.25)';
        g.beginPath();
        g.arc(24, 24, 20, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = boat.hullColor || '#0b1d3a';
        g.beginPath();
        g.moveTo(6, 26);
        g.lineTo(42, 22);
        g.lineTo(36, 36);
        g.lineTo(10, 36);
        g.closePath();
        g.fill();

        g.fillStyle = boat.accentColor || '#00f5d4';
        g.beginPath();
        g.moveTo(15, 24);
        g.lineTo(31, 22);
        g.lineTo(26, 13);
        g.lineTo(14, 13);
        g.closePath();
        g.fill();

        // Burun Minn Kota Trolling Motoru
        g.fillStyle = '#00f5d4';
        g.beginPath();
        g.arc(38, 16, 3, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#ffffff';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(38, 16);
        g.lineTo(38, 24);
        g.stroke();
    } else {
        // Sürat Teknesi
        g.fillStyle = boat.hullColor || '#e63946';
        g.beginPath();
        g.moveTo(5, 28);
        g.lineTo(43, 21);
        g.lineTo(35, 36);
        g.lineTo(11, 36);
        g.closePath();
        g.fill();

        g.fillStyle = boat.accentColor || '#ffbe0b';
        g.beginPath();
        g.moveTo(16, 25);
        g.lineTo(34, 21);
        g.lineTo(28, 16);
        g.closePath();
        g.fill();
    }
    return c;
}

// ============================================================================
// 6. BALIK TUTMA MEKANİĞİ & AUTO-HUNT (SPACE & O TUŞU)
// ============================================================================
const fishing = {
    state: 'IDLE', // 'IDLE', 'WAITING', 'MINIGAME'
    waterX: 0,
    waterY: 0,
    waterType: 'sea',
    waitTimer: 0,
    waitDuration: 0,
    bobberPhase: 0,
    currentFish: null,
    cursorPos: 50,
    cursorDir: 1,
    cursorSpeed: 1,
    greenStart: 35,
    greenWidth: 25
};

const fishingUI = document.getElementById('fishing-ui');
const fishingGreenEl = document.getElementById('fishing-bar-green');
const fishingCursorEl = document.getElementById('fishing-bar-cursor');
const fishingRarityLabel = document.getElementById('fishing-rarity-label');

function findNearbyWater() {
    if (currentMapId === 'akdeniz' || currentMapId === 'kraken') {
        // Akdeniz veya Kraken'de tekne üzerindeyiz; oltayı teknenin baktığı yöne doğru suya atarız
        const wx = Math.max(1.5, Math.min(MAP_SIZE - 1.5, player.x + (player.dirX || 1) * 1.5));
        const wy = Math.max(1.5, Math.min(MAP_SIZE - 1.5, player.y + (player.dirY || 0) * 1.5));
        return {
            x: wx,
            y: wy,
            tile: TILE.DEEP_SEA
        };
    }

    if (currentMapId !== 'burnaz_sahil') return null;
    const px = Math.floor(player.x);
    const py = Math.floor(player.y);
    let best = null;
    let bestDist = 999;

    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            const tx = px + dx;
            const ty = py + dy;
            if (isWaterTile(tx, ty)) {
                const d = Math.hypot((tx + 0.5) - player.x, (ty + 0.5) - player.y);
                if (d <= 2.5 && d < bestDist) {
                    bestDist = d;
                    best = {
                        x: tx + 0.5,
                        y: ty + 0.5,
                        tile: getActiveMap().grid[ty][tx]
                    };
                }
            }
        }
    }
    return best;
}

function findNearbyInteractable() {
    const m = getActiveMap();
    let best = null;
    let bestDist = 999;
    for (const inter of m.interactables) {
        const d = Math.hypot(inter.x - player.x, inter.y - player.y);
        if (d <= 2.6 && d < bestDist) {
            bestDist = d;
            best = inter;
        }
    }
    return best;
}

// Balık Tutarken İnci (%0.5) ve Ölü Denizcinin Hazinesi (%1) Drop Kontrolü
// ============================================================================
// KRAKEN ETKİNLİK ZAMANI & SEFER SAATLERİ (Kontrol Panelinden Yönetilebilir)
// ============================================================================
const DEFAULT_KRAKEN_EVENT_CONFIG = {
    enabled: true,        // Zaman kısıtlaması aktif mi (Sadece belirlenen saatlerde girilebilir)
    forceOpen: false,      // GM / Test modu için anlık zorla açık tutma
    intervals: [
        { id: 'k_ev_1', start: '12:00', end: '13:00', label: 'Öğle Seferi' },
        { id: 'k_ev_2', start: '18:00', end: '19:00', label: 'Akşam Seferi' },
        { id: 'k_ev_3', start: '21:00', end: '22:00', label: 'Gece Seferi' }
    ]
};

let KRAKEN_EVENT_CONFIG = JSON.parse(JSON.stringify(DEFAULT_KRAKEN_EVENT_CONFIG));

function isTimeInInterval(currentMinutes, startStr, endStr) {
    if (!startStr || !endStr) return false;
    const [sH, sM] = startStr.split(':').map(Number);
    const [eH, eM] = endStr.split(':').map(Number);
    const startMin = sH * 60 + (sM || 0);
    const endMin = eH * 60 + (eM || 0);
    if (startMin <= endMin) {
        return currentMinutes >= startMin && currentMinutes < endMin;
    } else {
        // Gece yarısını aşan aralık, örn: 23:00 - 01:00
        return currentMinutes >= startMin || currentMinutes < endMin;
    }
}

function getKrakenEventStatus() {
    if (!KRAKEN_EVENT_CONFIG.enabled) {
        return {
            isActive: true,
            status: 'always_open',
            label: '7/24 Açık (Zaman Kısıtlaması Devre Dışı)',
            color: '#80ed99',
            activeInterval: null,
            timeRemainingSec: 0,
            timeRemainingFormatted: 'Sınırsız',
            nextInterval: null,
            nextStartFormatted: ''
        };
    }
    if (KRAKEN_EVENT_CONFIG.forceOpen) {
        return {
            isActive: true,
            status: 'force_open',
            label: '⚡ Test / GM Zorla Açık Modu',
            color: '#ffd166',
            activeInterval: null,
            timeRemainingSec: 3600,
            timeRemainingFormatted: 'Süresiz (Test)',
            nextInterval: null,
            nextStartFormatted: ''
        };
    }

    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const currentSecTotal = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const intervals = Array.isArray(KRAKEN_EVENT_CONFIG.intervals) ? KRAKEN_EVENT_CONFIG.intervals : [];

    // Aktif bir sefer saat aralığında mıyız?
    for (const iv of intervals) {
        if (isTimeInInterval(currentMin, iv.start, iv.end)) {
            const [eH, eM] = iv.end.split(':').map(Number);
            let endSecTotal = eH * 3600 + (eM || 0) * 60;
            if (endSecTotal <= currentSecTotal) {
                endSecTotal += 24 * 3600;
            }
            const remSec = Math.max(0, endSecTotal - currentSecTotal);
            const m = Math.floor(remSec / 60);
            const s = remSec % 60;
            return {
                isActive: true,
                status: 'active',
                label: `🔥 Sefer Aktif: ${iv.label || 'Kraken Seferi'}`,
                color: '#2ec4b6',
                activeInterval: iv,
                timeRemainingSec: remSec,
                timeRemainingFormatted: `${m} dk ${s.toString().padStart(2, '0')} sn`,
                nextInterval: null,
                nextStartFormatted: ''
            };
        }
    }

    // Aktif değilse en yakın bir sonraki seferi hesapla
    let minWaitSec = Infinity;
    let nextIv = null;

    for (const iv of intervals) {
        if (!iv.start) continue;
        const [sH, sM] = iv.start.split(':').map(Number);
        let startSecTotal = sH * 3600 + (sM || 0) * 60;
        let waitSec = startSecTotal - currentSecTotal;
        if (waitSec <= 0) {
            waitSec += 24 * 3600;
        }
        if (waitSec < minWaitSec) {
            minWaitSec = waitSec;
            nextIv = iv;
        }
    }

    if (nextIv && minWaitSec < Infinity) {
        const waitHours = Math.floor(minWaitSec / 3600);
        const waitMins = Math.floor((minWaitSec % 3600) / 60);
        const waitSecs = minWaitSec % 60;
        const waitFormatted = waitHours > 0
            ? `${waitHours} sa ${waitMins} dk`
            : `${waitMins} dk ${waitSecs} sn`;

        return {
            isActive: false,
            status: 'closed',
            label: `⏳ Sefer Kapalı • Sonraki: ${nextIv.label} (${nextIv.start})`,
            color: '#f87171',
            activeInterval: null,
            timeRemainingSec: 0,
            timeRemainingFormatted: '0 dk',
            nextInterval: nextIv,
            nextStartFormatted: `${nextIv.start} (${waitFormatted} sonra)`
        };
    }

    return {
        isActive: false,
        status: 'closed',
        label: '🚫 Tanımlı Kraken Seferi Yok',
        color: '#f87171',
        activeInterval: null,
        timeRemainingSec: 0,
        timeRemainingFormatted: '0 dk',
        nextInterval: null,
        nextStartFormatted: 'Belirtilmedi'
    };
}

function isKrakenEventActive() {
    return getKrakenEventStatus().isActive;
}

// Süre Dolduğunda Kraken'deki Oyuncuları Otomatik Dörtyol'a Tahliye Etme Fonksiyonu
function returnFromKrakenToDortyolDueToEndOfEvent() {
    if (currentMapId !== 'kraken') return;
    if (typeof cancelFishing === 'function') cancelFishing();
    if (autoHunt && autoHunt.active && typeof stopAutoHunt === 'function') {
        stopAutoHunt("Kraken Seferi süresi dolduğu için Auto-Hunt durduruldu.");
    }
    currentMapId = 'dortyol';
    player.x = 21.5;
    player.y = 7.5;
    player.path = [];
    if (activeGuild) {
        activeGuild.krakenActive = false;
        saveGuildData();
    }
    showToast("⏰ Kraken Seferi Zamanı Sona Erdi! Lonca Destroyer'i ve tüm mürettebat Dörtyol Karargâhı'na tahliye edildi.", "#ef4444");
    if (typeof addChatMessage === 'function') {
        addChatMessage('Lonca', `⏰ [KRAKEN ETKİNLİĞİ BİTTİ] Sefer süresi dolduğu için Lonca Destroyer'i Dörtyol Karargâhı'na döndü! Tüm üyeler ana şehre tahliye edildi.`, 'system');
    }
}

// KRAKEN BÖLGESİ DİNAMİK DROP TABLOSU (Kontrol Panelinden Eklenebilir, Silinebilir ve Oranları Değiştirilebilir)
let KRAKEN_DROPS = [
    {
        itemId: 'item_kraken_shell',
        chance: 1.0,  // %1.0 Başlangıç İhtimali
        count: 1,
        announce: true
    }
];

function rollSpecialCraftDrops() {
    const pearlChance = Number(GAME_RULES.pearlDropChance ?? 0.5);
    const guildCarpenterLv = getGuildSkillLevel('guild_carpenter');
    const guildTreasureBonus = guildCarpenterLv * 0.5; // Lonca Marangozu: Seviye başına +%0.5
    const treasureChance = Number(GAME_RULES.treasureDropChance ?? 1.0) + guildTreasureBonus;
    const pirateChance = Number(GAME_RULES.pirateTreasureDropChance ?? 0.1);

    if (pearlChance > 0 && (Math.random() * 100) < pearlChance && ITEMS.item_pearl) {
        if (addItemToInventory('item_pearl', 1)) {
            showToast(`🦪 NADİR DROP! Balıkla birlikte [İnci] (%${pearlChance}) buldun!`, '#90e0ef');
        }
    }
    if (treasureChance > 0 && (Math.random() * 100) < treasureChance && ITEMS.item_dead_sailor_treasure) {
        if (addItemToInventory('item_dead_sailor_treasure', 1)) {
            showToast(`🏴‍☠️ HAZİNE BULUNDU! Oltana [Ölü Denizcinin Hazinesi] (%${treasureChance.toFixed(1)}) takıldı!`, '#ffbe0b');
        }
    }

    // Korsan Hazinesi: SADECE Akdeniz'deki Sarı Bereket Bölgesi İçerisindeyken %0.1 İhtimalle Düşer!
    const inHotspot = currentMapId === 'akdeniz' &&
        (isInOceanHotspot(player.x, player.y) || (fishing && isInOceanHotspot(fishing.waterX, fishing.waterY)));
    if (inHotspot && pirateChance > 0 && (Math.random() * 100) < pirateChance && ITEMS.item_pirate_treasure) {
        if (addItemToInventory('item_pirate_treasure', 1)) {
            showToast(`👑 EFSANEVİ DROP! Sarı Bereket Bölgesi'nden [Korsan Hazinesi] (%${pirateChance}) ÇIKTI!`, '#ffd166');
        }
    }

    // Kraliyet Muhafızı Kostümü: Okyanus (Akdeniz) Haritasında %0.01 İhtimalle Düşer!
    const royalGuardChance = Number(GAME_RULES.royalGuardDropChance ?? 0.01);
    if (currentMapId === 'akdeniz' && royalGuardChance > 0 && (Math.random() * 100) < royalGuardChance && ITEMS.costume_royal_guard) {
        if (addItemToInventory('costume_royal_guard', 1)) {
            showToast(`👑✨ EFSANEVİ MUCİZE! Okyanusun derinliklerinden [Kraliyet Muhafızı Kostümü] (%${royalGuardChance}) ÇIKTI! ✨👑`, '#ffd166');
            if (typeof addChatMessage === 'function') {
                addChatMessage('SİSTEM', `🌟 TEBRİKLER! [${player.name}] Okyanustan efsanevi Kraliyet Muhafızı Kostümü çıkardı!`, '#ffd166');
            }
        }
    }

    // KRAKEN HARİTASI ÖZEL DROPLARI (SADECE Kraken Haritasındayken Düşer!)
    if (currentMapId === 'kraken' && Array.isArray(KRAKEN_DROPS)) {
        KRAKEN_DROPS.forEach(drop => {
            const it = ITEMS[drop.itemId];
            if (!it) return;
            const chance = Number(drop.chance || 0);
            if (chance > 0 && (Math.random() * 100) < chance) {
                const count = Math.max(1, parseInt(drop.count) || 1);
                if (addItemToInventory(drop.itemId, count)) {
                    showToast(`🦑 KRAKEN DROPU! [${it.name}${count > 1 ? ` x${count}` : ''}] (%${chance}) KAZANDIN!`, '#ef4444');
                    if (drop.announce || it.isRoyal || it.isSOS) {
                        addChatMessage('Kraken', `🦑 TEBRİKLER! [${player.name}] Kraken Bölgesi'nden [${it.name}${count > 1 ? ` x${count}` : ''}] çıkardı!`, '#ef4444');
                    }
                }
            }
        });
    }
}

// Balık Seçimi (Kontrol Panelindeki Nadirlik Oranlarına, Akdeniz Havuzuna ve Sarı Bölge 1.5x Çarpanına Göre Dinamik)
function selectRandomFish(waterType, isAutoHunt = false) {
    const stats = getPlayerFishingStats();
    const luckMult = 1 + (stats.luckPct / 100);
    const autoPenalty = isAutoHunt ? GAME_RULES.autoHuntLuckMult : 1.0;

    // Akdeniz'de Sarı Bölge (Hotspot) içerisindeysek değerli balık tutma ihtimali 1.5x!
    const inHotspot = currentMapId === 'akdeniz' &&
        (isInOceanHotspot(player.x, player.y) || isInOceanHotspot(fishing.waterX, fishing.waterY));
    const hotspotMult = inHotspot ? (GAME_RULES.hotspotLuckMult || 1.5) : 1.0;

    const guildBlessingLv = getGuildSkillLevel('guild_blessing');
    const guildLegendaryBonus = guildBlessingLv * 0.5; // Lonca Kutsaması: Seviye başına +%0.5
    const pLegendary = (RARITY.LEGENDARY.baseChance + guildLegendaryBonus) * luckMult * autoPenalty * hotspotMult;
    const pEpic      = RARITY.EPIC.baseChance      * luckMult * autoPenalty * hotspotMult;
    const pRare      = RARITY.RARE.baseChance      * luckMult * autoPenalty * hotspotMult;
    const pUncommon  = RARITY.UNCOMMON.baseChance  * luckMult * autoPenalty * hotspotMult;

    const roll = Math.random() * 100;
    let chosenRarityKey = 'COMMON';

    if (roll < pLegendary) {
        chosenRarityKey = 'LEGENDARY';
    } else if (roll < pLegendary + pEpic) {
        chosenRarityKey = 'EPIC';
    } else if (roll < pLegendary + pEpic + pRare) {
        chosenRarityKey = 'RARE';
    } else if (roll < pLegendary + pEpic + pRare + pUncommon) {
        chosenRarityKey = 'UNCOMMON';
    }

    // Bu su tipine ve nadirliğe uygun tüm balıkları bul
    const allFishes = Object.values(ITEMS).filter(i => i.type === 'fish');
    let pool = [];
    if (waterType === 'ocean') {
        pool = allFishes.filter(f =>
            (f.rarityKey === chosenRarityKey || f.rarity?.id === RARITY[chosenRarityKey]?.id) &&
            f.habitat === 'ocean'
        );
        if (pool.length === 0) {
            pool = allFishes.filter(f => f.habitat === 'ocean');
        }
    } else {
        pool = allFishes.filter(f =>
            (f.rarityKey === chosenRarityKey || f.rarity?.id === RARITY[chosenRarityKey]?.id) &&
            (f.habitat === waterType || f.habitat === 'both' || !f.habitat)
        );
        if (pool.length === 0) {
            pool = allFishes.filter(f => f.habitat === waterType || f.habitat === 'both');
        }
    }

    if (pool.length === 0) {
        return ITEMS.fish_perch;
    }

    return pool[Math.floor(Math.random() * pool.length)];
}

function castFishingLine(water, isAuto = false) {
    player.path = [];
    player.targetMarker = null;
    const dx = water.x - player.x;
    const dy = water.y - player.y;
    const len = Math.hypot(dx, dy) || 1;
    player.dirX = dx / len;
    player.dirY = dy / len;

    const stats = getPlayerFishingStats();
    const minW = Math.max(1, GAME_RULES.minWaitSec);
    const maxW = Math.max(minW, GAME_RULES.maxWaitSec);
    const baseWait = minW + Math.random() * (maxW - minW);
    const speedFactor = Math.max(0.2, 1 - (stats.speedPct / 100));

    let autoTimeMultiplier = isAuto ? GAME_RULES.autoHuntTimeMult : 1.0;
    if (isAuto) {
        if (player.equipped.rod) {
            const rod = ITEMS[player.equipped.rod];
            if (rod && rod.autoHuntSpeedBonus) {
                autoTimeMultiplier *= Math.max(0.2, 1 - (rod.autoHuntSpeedBonus / 100));
            }
        }
        const eqCostume = getEquippedCostumeItem();
        if (eqCostume && eqCostume.autoHuntSpeedBonus) {
            autoTimeMultiplier *= Math.max(0.2, 1 - (eqCostume.autoHuntSpeedBonus / 100));
        }
        const guildVeteranLv = getGuildSkillLevel('guild_veteran');
        if (guildVeteranLv > 0) {
            // Lonca Emektarı: Seviye başına Auto-Hunt'ı %5 hızlandırır
            autoTimeMultiplier *= Math.max(0.2, 1 - ((guildVeteranLv * 5) / 100));
        }
    }

    fishing.state = 'WAITING';
    fishing.waterX = water.x;
    fishing.waterY = water.y;
    fishing.waterType = (currentMapId === 'akdeniz' || currentMapId === 'kraken')
        ? 'ocean'
        : (water.tile === TILE.LAKE ? 'lake' : 'sea');
    fishing.waitTimer = 0;
    fishing.waitDuration = baseWait * speedFactor * autoTimeMultiplier;
}

// Auto-Hunt Aç / Kapat (O Tuşu)
function toggleAutoHunt() {
    if (autoHunt.active) {
        stopAutoHunt('🤖 Auto-Hunt kapatıldı.');
        return;
    }

    // 1. Şehir Kontrolü: Dörtyol şehrinde Auto-Hunt tamamen pasiftir!
    if (currentMapId === 'dortyol') {
        showToast('🏙️ Şehir merkezinde balık tutulamaz! Auto-Hunt (O) devre dışıdır.', '#ff595e');
        return;
    }

    if (!player.equipped.rod) {
        showToast('⚠️ Auto-Hunt başlatmak için önce envanterden (I) bir Olta kuşanmalısın!', '#ff595e');
        return;
    }

    // 2. Suya Yakınlık Kontrolü: O tuşu sadece su kenarındayken aktif olabilir!
    const water = findNearbyWater();
    if (!water) {
        showToast('🌊 Auto-Hunt (O) başlatmak için su kıyısına yaklaşmalısın!', '#4cc9f0');
        return;
    }

    // 3. Akdeniz'deyken Minnkota Otopilot Kontrolü (Asla şehir veya karadan okyanusa ışınlamaz!)
    const isMinnkotaInOcean = (currentMapId === 'akdeniz' && player.activeBoatId === 'boat_minnkota');

    if (isMinnkotaInOcean) {
        autoHunt.active = true;
        autoHunt.caughtCount = 0;
        autoHunt.cooldownTimer = 0;

        if (fishing.state === 'MINIGAME') {
            fishingUI.classList.add('hidden');
        }

        // Zaten Sarı Bereket Bölgesi içinde miyiz?
        if (isInOceanHotspot(player.x, player.y)) {
            autoHunt.navigatingToHotspot = false;
            castFishingLine(water, true);
            updateAutoHuntHUD();
            showToast("🎯 [Minnkota Otopilot] Sarı Bereket Bölgesi'ndeyiz! Otomatik avlanma başladı.", '#00f5d4');
        } else {
            // Sarı Bölgeye doğru GPS rotası çiz
            autoHunt.navigatingToHotspot = true;
            if (fishing.state !== 'IDLE') cancelFishing();
            const path = findPath(player.x, player.y, oceanHotspot.x, oceanHotspot.y);
            if (path && path.length > 0) {
                player.path = path;
            }
            updateAutoHuntHUD();
            showToast("🧭 [Minnkota Otopilot] Sarı Bereket Bölgesi'ne rota çizildi. Tekne otomatik ilerliyor...", '#00f5d4');
        }
        return;
    }

    // 4. Karada (Burnaz Sahil kıyısında) veya Akdeniz'de normal tekneyle avlanma:
    if (fishing.state === 'MINIGAME') {
        fishingUI.classList.add('hidden');
    }

    autoHunt.active = true;
    autoHunt.navigatingToHotspot = false;
    autoHunt.cooldownTimer = 0;
    castFishingLine(water, true);
    updateAutoHuntHUD();
    showToast('🤖 Auto-Hunt başlatıldı! (Süre: 4x Uzun, Nadirlik Şansı: 1/3)', '#80ed99');
}

function stopAutoHunt(reason) {
    if (!autoHunt.active) return;
    autoHunt.active = false;
    autoHunt.navigatingToHotspot = false;
    autoHunt.cooldownTimer = 0;
    if (fishing.state !== 'IDLE') {
        fishing.state = 'IDLE';
        fishingUI.classList.add('hidden');
    }
    updateAutoHuntHUD();
    if (reason) showToast(reason, '#adb5bd');
}

function updateAutoHuntHUD() {
    const box = document.getElementById('autohunt-panel');
    const badge = document.getElementById('ah-status-badge');
    const progWrap = document.getElementById('ah-progress-wrap');
    const progFill = document.getElementById('ah-progress-fill');
    const progText = document.getElementById('ah-progress-text');

    if (autoHunt.active) {
        box.classList.add('active');
        badge.className = 'ah-badge on';
        badge.textContent = 'AKTİF [O]';
        progWrap.classList.remove('hidden');

        if (autoHunt.navigatingToHotspot) {
            progFill.style.width = '100%';
            progText.textContent = `🧭 Minnkota Otopilot: Sarı Bereket Bölgesi'ne seyir ediliyor...`;
        } else if (fishing.state === 'WAITING') {
            const pct = Math.min(100, (fishing.waitTimer / fishing.waitDuration) * 100);
            const rem = Math.max(0, fishing.waitDuration - fishing.waitTimer).toFixed(1);
            progFill.style.width = `${pct}%`;
            progText.textContent = `Otomatik çekiliyor: ${rem} sn (Tutulan: ${autoHunt.caughtCount})`;
        } else {
            progFill.style.width = '100%';
            progText.textContent = `Yeni olta hazırlanıyor... (Tutulan: ${autoHunt.caughtCount})`;
        }
    } else {
        box.classList.remove('active');
        badge.className = 'ah-badge off';
        badge.textContent = 'KAPALI [O]';
        progWrap.classList.add('hidden');
    }
}

function isAnyModalOpen() {
    const authModal = document.getElementById('auth-gateway-modal');
    if (authModal && !authModal.classList.contains('hidden')) return true;

    const charModal = document.getElementById('char-create-modal');
    if (charModal && !charModal.classList.contains('hidden')) return true;

    return !document.getElementById('inventory-modal').classList.contains('hidden') ||
           !document.getElementById('npc-modal').classList.contains('hidden') ||
           !document.getElementById('skill-modal').classList.contains('hidden') ||
           !document.getElementById('guild-modal').classList.contains('hidden') ||
           !document.getElementById('admin-modal').classList.contains('hidden') ||
           !(document.getElementById('wiki-modal')?.classList.contains('hidden') ?? true);
}

function handleSpaceAction() {
    if (isAnyModalOpen()) return;

    if (autoHunt.active) {
        showToast('🤖 Şu an Auto-Hunt aktif! Manuel balık tutmak için [O] tuşuna basarak Auto-Hunt\'ı kapatabilirsin.', '#ffbe0b');
        return;
    }

    if (fishing.state === 'IDLE') {
        const nearbyInter = findNearbyInteractable();
        if (nearbyInter) {
            interactWithObject(nearbyInter);
            return;
        }

        if (!player.equipped.rod) {
            showToast('⚠️ Balık tutmak için önce envanterden (I) bir Olta kuşanmalısın!', '#ff595e');
            return;
        }

        const water = findNearbyWater();
        if (!water) {
            showToast('🌊 Olta atmak için göl veya deniz kıyısına yaklaşmalısın!', '#4cc9f0');
            return;
        }

        castFishingLine(water, false);
        const inHotspot = currentMapId === 'akdeniz' &&
            (isInOceanHotspot(player.x, player.y) || isInOceanHotspot(fishing.waterX, fishing.waterY));
        const locName = fishing.waterType === 'ocean'
            ? (inHotspot ? 'Akdeniz 🌟 Sarı Bereket Bölgesi (1.5x Şans!)' : 'Akdeniz Açık Okyanusu')
            : (fishing.waterType === 'lake' ? 'Küçük Göl' : 'Burnaz Denizi');
        showToast(`🎣 Oltayı ${locName} sularına attın! Balık bekleniyor...`, inHotspot ? '#ffbe0b' : '#ffd166');
    } else if (fishing.state === 'WAITING') {
        cancelFishing('Oltayı erken çektin.');
    } else if (fishing.state === 'MINIGAME') {
        const hitStart = fishing.greenStart - 1.0;
        const hitEnd = fishing.greenStart + fishing.greenWidth + 1.0;

        if (fishing.cursorPos >= hitStart && fishing.cursorPos <= hitEnd) {
            const caught = fishing.currentFish;
            if (!addItemToInventory(caught.id, 1)) {
                showToast('⚠️ Çantan dolu! Depocu Tarık\'a uğrayıp eşyalarını kasaya koyabilirsin.', '#ff595e');
            } else {
                if (player.equipped.bait) consumeBait(player.equipped.bait);
                gainExp(caught.rarity.expGain);
                gainGuildExp(caught.rarity?.id || caught.rarityKey);
                showToast(`✨ HARİKA! [${caught.rarity.name}] ${caught.name} yakaladın! (+%${caught.rarity.expGain} EXP)`, caught.rarity.color);
                rollSpecialCraftDrops();
            }
        } else {
            showToast(`💨 Kaçırdın! ${fishing.currentFish.name} oltadan kurtuldu!`, '#ff595e');
        }

        fishing.state = 'IDLE';
        fishingUI.classList.add('hidden');
    }
}

function startFishingMinigame() {
    fishing.state = 'MINIGAME';
    const fish = selectRandomFish(fishing.waterType, false);
    fishing.currentFish = fish;

    const stats = getPlayerFishingStats();
    const widthBonus = stats.barSlowPct * 0.25;
    const speedReduction = Math.max(0.35, 1 - (stats.barSlowPct / 100));

    fishing.greenWidth = Math.min(48, fish.rarity.greenWidth + widthBonus);
    fishing.greenStart = 12 + Math.random() * (76 - fishing.greenWidth);

    fishing.cursorPos = 6;
    fishing.cursorDir = 1;
    fishing.cursorSpeed = Math.max(0.45, fish.rarity.speed * speedReduction);

    fishingGreenEl.style.left = `${fishing.greenStart}%`;
    fishingGreenEl.style.width = `${fishing.greenWidth}%`;
    fishingCursorEl.style.left = `${fishing.cursorPos}%`;

    fishingRarityLabel.textContent = fish.rarity.name;
    fishingRarityLabel.style.backgroundColor = fish.rarity.color;
    fishingRarityLabel.style.color = '#111';

    fishingUI.classList.remove('hidden');
}

function cancelFishing(reason) {
    if (fishing.state !== 'IDLE') {
        fishing.state = 'IDLE';
        fishingUI.classList.add('hidden');
        if (reason) showToast(reason, '#adb5bd');
    }
}

// ============================================================================
// 7. ENVANTER, YETENEK AĞACI (K), DEPO VE NPC PENCERELERİ
// ============================================================================
function generateItemUid() {
    return 'uid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function addItemToInventory(itemId, count = 1, customEnchants = null) {
    const item = ITEMS[itemId];
    if (!item) return false;

    // Oltalar ve Kostümler tekil (her birinin kendi + efsunu ve uid'si olur) olarak eklenir
    if (item.type === 'rod' || item.type === 'costume') {
        if (player.inventory.length + count > 24) return false;
        let lastUid = null;
        for (let c = 0; c < count; c++) {
            lastUid = generateItemUid();
            player.inventory.push({
                id: itemId,
                count: 1,
                uid: lastUid,
                enchants: customEnchants
                    ? { ...customEnchants }
                    : { count: 0, luck: 0, speed: 0, control: 0 }
            });
        }
        return lastUid || true;
    }

    const existing = player.inventory.find(i => i.id === itemId);
    if (existing) {
        existing.count += count;
        return true;
    }
    if (player.inventory.length >= 24) return false;
    player.inventory.push({ id: itemId, count });
    return true;
}

function removeItemByUid(uid) {
    const idx = player.inventory.findIndex(i => i.uid === uid);
    if (idx === -1) return false;
    const removed = player.inventory[idx];
    if (player.equipped.rodUid === uid) {
        player.equipped.rod = null;
        player.equipped.rodUid = null;
    }
    if (player.equipped.costumeUid === uid) {
        player.equipped.costume = null;
        player.equipped.costumeUid = null;
    }
    if (anvilState.rodUid === uid) {
        anvilState.rodUid = null;
    }
    if (anvilState.itemUid === uid) {
        anvilState.itemUid = null;
    }
    player.inventory.splice(idx, 1);
    // Başka aynı tür olta veya kostüm kuşanılmamışsa kontrol et
    if (player.equipped.rod === removed.id && !player.equipped.rodUid) {
        const another = player.inventory.find(i => i.id === removed.id);
        if (another) {
            player.equipped.rodUid = another.uid;
        } else {
            player.equipped.rod = null;
        }
    }
    if (player.equipped.costume === removed.id && !player.equipped.costumeUid) {
        const another = player.inventory.find(i => i.id === removed.id);
        if (another) {
            player.equipped.costumeUid = another.uid;
        } else {
            player.equipped.costume = null;
        }
    }
    return true;
}

function removeItemFromInventory(itemId, count = 1) {
    const idx = player.inventory.findIndex(i => i.id === itemId);
    if (idx === -1) return false;
    const entry = player.inventory[idx];
    if (entry.uid && (ITEMS[itemId]?.type === 'rod' || ITEMS[itemId]?.type === 'costume')) {
        return removeItemByUid(entry.uid);
    }
    entry.count -= count;
    if (entry.count <= 0) {
        if (player.equipped.rod === itemId) {
            player.equipped.rod = null;
            player.equipped.rodUid = null;
        }
        if (player.equipped.bait === itemId) player.equipped.bait = null;
        if (player.equipped.costume === itemId) {
            player.equipped.costume = null;
            player.equipped.costumeUid = null;
        }
        if (anvilState.scrollId === itemId) anvilState.scrollId = null;
        if (anvilState.protectScrollId === itemId) anvilState.protectScrollId = null;
        player.inventory.splice(idx, 1);
    }
    return true;
}

// Kostüm ve Oltaların Depolarda Stacklenmesini Önleyen ve + Seviyelerini Koruyan Onarıcı
function sanitizeVaultAndInventoryCostumes() {
    // 1. Envanterdeki kostüm ve oltaları denetle & onar
    if (Array.isArray(player.inventory)) {
        player.inventory.forEach(entry => {
            if (!entry) return;
            const it = ITEMS[entry.id];
            if (it && (it.type === 'costume' || it.type === 'rod')) {
                if (!entry.uid) entry.uid = generateItemUid();
                if (!entry.enchants || typeof entry.enchants.count !== 'number') {
                    const fallback = (it.type === 'costume' ? player.costumeEnchants?.[entry.id] : player.rodEnchants?.[entry.id]);
                    entry.enchants = fallback ? { ...fallback } : { count: 0, luck: 0, speed: 0, control: 0 };
                } else if (it.type === 'costume' && entry.enchants.count > 0) {
                    player.costumeEnchants = player.costumeEnchants || {};
                    if (!player.costumeEnchants[entry.id] || player.costumeEnchants[entry.id].count < entry.enchants.count) {
                        player.costumeEnchants[entry.id] = { ...entry.enchants };
                        try { localStorage.setItem('mmo_costume_enchants', JSON.stringify(player.costumeEnchants)); } catch(e) {}
                    }
                }
            }
        });
    }

    // 2. Oyuncu şahsi kasası (Depocu Tarık)
    if (Array.isArray(player.storage)) {
        player.storage.forEach(page => {
            if (!Array.isArray(page)) return;
            for (let i = 0; i < page.length; i++) {
                const entry = page[i];
                if (!entry) continue;
                const it = ITEMS[entry.id];
                if (it && (it.type === 'costume' || it.type === 'rod')) {
                    if (!entry.uid) entry.uid = generateItemUid();
                    if (!entry.enchants || typeof entry.enchants.count !== 'number' || entry.enchants.count === 0) {
                        const fallback = (it.type === 'costume' ? player.costumeEnchants?.[entry.id] : player.rodEnchants?.[entry.id]);
                        if (fallback && fallback.count > 0) {
                            entry.enchants = { ...fallback };
                        } else if (!entry.enchants) {
                            entry.enchants = { count: 0, luck: 0, speed: 0, control: 0 };
                        }
                    }
                    // Eğer kostüm veya olta üst üste stacklenmişse, her birini 1'erli ayrı slotlara ayır
                    if (entry.count > 1) {
                        const excess = entry.count - 1;
                        entry.count = 1;
                        for (let k = 0; k < excess; k++) {
                            const freeIdx = page.findIndex(s => s === null);
                            if (freeIdx !== -1) {
                                page[freeIdx] = {
                                    id: entry.id,
                                    count: 1,
                                    uid: generateItemUid(),
                                    enchants: { ...entry.enchants }
                                };
                            }
                        }
                    }
                }
            }
        });
    }

    // 3. Lonca Kasası (Lonca Tapınağı Bankası)
    if (typeof activeGuild !== 'undefined' && activeGuild && Array.isArray(activeGuild.vault)) {
        let vaultChanged = false;
        activeGuild.vault.forEach(page => {
            if (!Array.isArray(page)) return;
            for (let i = 0; i < page.length; i++) {
                const entry = page[i];
                if (!entry) continue;
                const it = ITEMS[entry.id];
                if (it && (it.type === 'costume' || it.type === 'rod')) {
                    if (!entry.uid) { entry.uid = generateItemUid(); vaultChanged = true; }
                    if (!entry.enchants || typeof entry.enchants.count !== 'number' || entry.enchants.count === 0) {
                        const fallback = (it.type === 'costume' ? player.costumeEnchants?.[entry.id] : player.rodEnchants?.[entry.id]);
                        if (fallback && fallback.count > 0) {
                            entry.enchants = { ...fallback };
                            vaultChanged = true;
                        } else if (!entry.enchants) {
                            entry.enchants = { count: 0, luck: 0, speed: 0, control: 0 };
                            vaultChanged = true;
                        }
                    }
                    if (entry.count > 1) {
                        const excess = entry.count - 1;
                        entry.count = 1;
                        vaultChanged = true;
                        for (let k = 0; k < excess; k++) {
                            const freeIdx = page.findIndex(s => s === null);
                            if (freeIdx !== -1) {
                                page[freeIdx] = {
                                    id: entry.id,
                                    count: 1,
                                    uid: generateItemUid(),
                                    enchants: { ...entry.enchants }
                                };
                            }
                        }
                    }
                }
            }
        });
        if (vaultChanged && typeof saveGuildData === 'function') {
            saveGuildData();
        }
    }
}

function getItemCountInInventory(itemId) {
    return player.inventory.filter(i => i.id === itemId).reduce((acc, cur) => acc + (cur.count || 1), 0);
}

function removeMultipleFromInventory(itemId, count) {
    let left = count;
    for (let i = player.inventory.length - 1; i >= 0; i--) {
        const entry = player.inventory[i];
        if (entry.id === itemId) {
            if (entry.count <= left) {
                left -= entry.count;
                player.inventory.splice(i, 1);
            } else {
                entry.count -= left;
                left = 0;
            }
            if (left <= 0) break;
        }
    }
    return left === 0;
}

function pushToBuyback(itemId, count, unitPrice, enchants = null) {
    player.buybackList.unshift({
        buybackId: generateItemUid(),
        id: itemId,
        count,
        unitPrice,
        totalPrice: unitPrice * count,
        enchants: enchants ? { ...enchants } : null
    });
    if (player.buybackList.length > 20) {
        player.buybackList.pop();
    }
}

function consumeBait(baitId) {
    // 1. Balıkçının Duası: Seviyelere göre (%10, %15, %20, %25, %30) yemin eksilmesini engeller
    const prayerLv = player.skills.fisherman_prayer || 0;
    const saveChances = [0, 10, 15, 20, 25, 30];
    const saveChance = saveChances[prayerLv] || 0;
    if (saveChance > 0 && (Math.random() * 100) < saveChance) {
        showToast('🙏 [Balıkçının Duası] Kadim dua sayesinde yemin korundu ve eksilmedi!', '#4cc9f0');
        return;
    }

    // 2. Kostüm Yem Koruma Bonusu (Kraliyet Muhafızı: %20 Yem Koruma Şansı)
    const eqCostume = getEquippedCostumeItem();
    if (eqCostume && eqCostume.baitProtectBonus && (Math.random() * 100) < eqCostume.baitProtectBonus) {
        showToast('🛡️ [Kraliyet Muhafızı] Asil zırhın sayesinde yemin korundu ve eksilmedi!', '#ffd166');
        return;
    }

    removeItemFromInventory(baitId, 1);
    if (!player.inventory.some(i => i.id === baitId)) {
        player.equipped.bait = null;
        showToast('🪱 Kuşandığın yem tükendi!', '#ffbe0b');
    }
}

function activateCookedFishBuff(cookedItem) {
    const r = cookedItem.rarity;
    // Gusto Şef'in Mahareti: Seviyelere göre (+%10..+%50) buff süresini uzatır
    const chefLv = player.skills.chef_gusto_mastery || 0;
    // Kostüm Buff Süresi Uzatma Bonusu (Kraliyet Muhafızı: +%20)
    const eqCostume = getEquippedCostumeItem();
    const costumeBuffBonus = (eqCostume && eqCostume.buffDurationBonus) ? (eqCostume.buffDurationBonus / 100) : 0;
    const durationMult = 1 + (chefLv * 0.10) + costumeBuffBonus;
    const duration = Math.round(600 * durationMult);

    const existing = player.buffs.find(b => b.type === r.buffType);
    if (existing) {
        existing.val = Math.max(existing.val, r.buffVal);
        existing.remaining = duration;
        existing.name = cookedItem.name;
    } else {
        player.buffs.push({
            id: cookedItem.id,
            name: cookedItem.name,
            type: r.buffType,
            val: r.buffVal,
            remaining: duration
        });
    }
    const mins = Math.floor(duration / 60);
    showToast(`🍖 ${cookedItem.name} yendi! (${r.buffDesc} • ${mins} Dakika Buff)`, '#80ed99');
    renderBuffBar();
}

function renderBuffBar() {
    const bar = document.getElementById('buff-bar');
    if (!bar) return;
    bar.innerHTML = '';

    let hasAnyBuff = false;

    // 1. Şef'in Süreli Yemek Buffları
    player.buffs.forEach(b => {
        hasAnyBuff = true;
        const mins = Math.floor(b.remaining / 60);
        const secs = Math.floor(b.remaining % 60).toString().padStart(2, '0');
        const label = b.type === 'luck' ? `+%${b.val} Şans`
                    : b.type === 'speed' ? `-%${b.val} Bekleme`
                    : `-%${b.val} Bar Hızı`;

        const pill = document.createElement('div');
        pill.className = 'buff-pill';
        pill.innerHTML = `
            <span class="buff-name">🍖 <b>${b.name || 'Yemek'}</b> (${label})</span>
            <span class="buff-timer">⏳ ${mins}:${secs}</span>
        `;
        bar.appendChild(pill);
    });

    // 2. Akdeniz Sarı Bereket Bölgesi (1.5x Şans - Süreli)
    const inHotspot = currentMapId === 'akdeniz' &&
        (isInOceanHotspot(player.x, player.y) || (fishing.state !== 'IDLE' && isInOceanHotspot(fishing.waterX, fishing.waterY)));
    if (inHotspot) {
        hasAnyBuff = true;
        const remSec = Math.max(0, Math.floor(oceanHotspot.timer));
        const remM = Math.floor(remSec / 60);
        const remS = (remSec % 60).toString().padStart(2, '0');

        const pill = document.createElement('div');
        pill.className = 'buff-pill hotspot-buff';
        pill.innerHTML = `
            <span class="buff-name">🌟 <b>Sarı Bereket</b> (1.5x Şans)</span>
            <span class="buff-timer">⏳ ${remM}:${remS}</span>
        `;
        bar.appendChild(pill);
    }

    // 3. Balıkçı Burak'ın Efsunlu Oltası (SOS)
    if (player.equipped.rod === 'rod_burak') {
        hasAnyBuff = true;
        const pill = document.createElement('div');
        pill.className = 'buff-pill rod-sos-buff';
        pill.innerHTML = `
            <span class="buff-name">🔱 <b>Efsunlu Olta (SOS)</b> (+%5 Şans, +%30 Auto)</span>
            <span class="buff-timer permanent-badge">Sürekli</span>
        `;
        bar.appendChild(pill);
    }

    // 4. Yeteneklerden Gelen Pasif Bonuslar (K Ağacı)
    PASSIVE_SKILLS.forEach(sk => {
        const curLv = player.skills[sk.id] || 0;
        if (curLv > 0) {
            hasAnyBuff = true;
            let valStr = '';
            if (sk.id === 'burak_tactics') {
                valStr = `+%${curLv * (sk.effectPerLevel || 2)} Nadir Şansı`;
            } else if (sk.id === 'talha_luck') {
                valStr = `-%${curLv * (sk.effectPerLevel || 5)} Balık Süresi`;
            } else if (sk.id === 'duran_beret') {
                valStr = `-%${curLv * (sk.effectPerLevel || 3)} Bar Hızı`;
            } else if (sk.id === 'chef_gusto_mastery') {
                valStr = `+%${curLv * (sk.effectPerLevel || 10)} Buff Süresi`;
            } else if (sk.id === 'carpenter_wisdom') {
                valStr = `+%${curLv * (sk.effectPerLevel || 1)} Malzeme Koruma`;
            } else if (sk.id === 'anvil_patron') {
                valStr = `+%${curLv * (sk.effectPerLevel || 1)} Başarı Oranı`;
            } else if (sk.id === 'fisherman_prayer') {
                const prayerVals = [0, 10, 15, 20, 25, 30];
                valStr = `%${prayerVals[curLv] || 0} Yem Koruma`;
            } else {
                valStr = `+%${curLv * (sk.effectPerLevel || 1)}`;
            }

            const pill = document.createElement('div');
            pill.className = 'buff-pill skill-buff';
            pill.innerHTML = `
                <span class="buff-name">${sk.icon} <b>${sk.name}</b> (${valStr})</span>
                <span class="buff-timer skill-badge">Lv.${curLv} Pasif</span>
            `;
            bar.appendChild(pill);
        }
    });

    if (!hasAnyBuff) {
        bar.innerHTML = `<div class="no-buffs-text">Üzerinde aktif buff veya bonus bulunmuyor</div>`;
    }
}

// Envanter Aç/Kapat (I Tuşu)
function toggleInventory() {
    const modal = document.getElementById('inventory-modal');
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
        document.getElementById('npc-modal').classList.add('hidden');
        document.getElementById('skill-modal').classList.add('hidden');
        renderInventoryUI();
    } else {
        isTrashMode = false;
        selectedTrashIndices.clear();
    }
}

// Yetenek Ağacı Aç/Kapat (K Tuşu)
function toggleSkillTree() {
    const modal = document.getElementById('skill-modal');
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
        document.getElementById('inventory-modal').classList.add('hidden');
        document.getElementById('npc-modal').classList.add('hidden');
        renderSkillTreeUI();
    }
}

document.getElementById('close-inv-btn').addEventListener('click', toggleInventory);
document.getElementById('close-skill-btn').addEventListener('click', toggleSkillTree);
document.getElementById('hud-skill-btn').addEventListener('click', toggleSkillTree);
document.getElementById('close-npc-btn').addEventListener('click', () => {
    document.getElementById('npc-modal').classList.add('hidden');
});

// Yetenekleri Sıfırla Butonu (1 Adet İnci Gerekir)
document.getElementById('reset-skills-btn').addEventListener('click', () => {
    let totalSpent = 0;
    PASSIVE_SKILLS.forEach(sk => {
        totalSpent += (player.skills[sk.id] || 0);
    });
    if (totalSpent === 0) {
        showToast('Sıfırlanacak harcanmış yetenek puanı yok.', '#adb5bd');
        return;
    }
    const pearlEntry = player.inventory.find(i => i.id === 'item_pearl');
    const pearlCount = pearlEntry ? pearlEntry.count : 0;
    if (pearlCount < 1) {
        showToast('⚠️ Karakter yeteneklerini sıfırlamak için envanterinde 1 adet [İnci] olmalıdır!', '#ff595e');
        return;
    }
    if (!confirm('Karakter yetenek ağacını sıfırlamak için 1 adet İnci harcanacak. Onaylıyor musun?')) {
        return;
    }
    removeItemFromInventory('item_pearl', 1);
    PASSIVE_SKILLS.forEach(sk => {
        player.skills[sk.id] = 0;
    });
    player.skillPoints += totalSpent;
    updateExpHUD();
    renderSkillTreeUI();
    renderBuffBar();
    showToast(`🔄 Yetenek ağacı sıfırlandı! 1 İnci harcandı ve ${totalSpent} yetenek puanı iade edildi.`, '#4cc9f0');
});

function renderSkillTreeUI() {
    document.getElementById('sk-char-lv').textContent = `Lv. ${player.level} / ${MAX_PLAYER_LEVEL}`;
    document.getElementById('sk-avail-points').textContent = player.skillPoints;

    const list = document.getElementById('skill-tree-list');
    list.innerHTML = '';

    PASSIVE_SKILLS.forEach(sk => {
        const curLv = player.skills[sk.id] || 0;
        const totalBonus = curLv * sk.effectPerLevel;

        const card = document.createElement('div');
        card.className = 'skill-card';

        let pipsHtml = '';
        for (let i = 1; i <= sk.maxLevel; i++) {
            pipsHtml += `<span class="skill-pip ${i <= curLv ? 'filled' : ''}"></span>`;
        }

        let bonusLabel = '';
        if (sk.id === 'burak_tactics') {
            bonusLabel = `Aktif Bonus: Nadirlik Şansı +%${totalBonus}`;
        } else if (sk.id === 'talha_luck') {
            bonusLabel = `Aktif Bonus: Balık Tutma Süresi -%${totalBonus}`;
        } else if (sk.id === 'duran_beret') {
            bonusLabel = `Aktif Bonus: Bar Hareket Hızı -%${totalBonus}`;
        } else if (sk.id === 'chef_gusto_mastery') {
            bonusLabel = `Aktif Bonus: Yemek Buff Süresi +%${totalBonus}`;
        } else if (sk.id === 'carpenter_wisdom') {
            bonusLabel = `Aktif Bonus: Craft Malzeme Koruma %${totalBonus}`;
        } else if (sk.id === 'anvil_patron') {
            bonusLabel = `Aktif Bonus: Anvil Başarı Oranı +%${totalBonus}`;
        } else if (sk.id === 'fisherman_prayer') {
            const prayerVals = [0, 10, 15, 20, 25, 30];
            bonusLabel = `Aktif Bonus: Yem Koruma Şansı %${prayerVals[curLv] || 0}`;
        } else {
            bonusLabel = `Aktif Bonus: +${totalBonus}`;
        }

        card.innerHTML = `
            <div class="skill-card-left">
                <div class="skill-icon-box">${sk.icon}</div>
                <div>
                    <div class="skill-title">${sk.name} <span style="color:#adb5bd; font-size:12px;">(${curLv} / ${sk.maxLevel})</span></div>
                    <div class="skill-desc">${sk.desc}</div>
                    <div class="skill-bonus-text">${sk.perLevelText} • <b>${bonusLabel}</b></div>
                </div>
            </div>
            <div class="skill-card-right">
                <div class="skill-pips">${pipsHtml}</div>
                <button class="action-btn primary" id="up-btn-${sk.id}" ${curLv >= sk.maxLevel || player.skillPoints <= 0 ? 'disabled' : ''}>
                    ${curLv >= sk.maxLevel ? 'MAKSİMUM' : '➕ Geliştir (1 Puan)'}
                </button>
            </div>
        `;

        list.appendChild(card);

        document.getElementById(`up-btn-${sk.id}`).onclick = () => {
            if (player.skillPoints > 0 && (player.skills[sk.id] || 0) < sk.maxLevel) {
                player.skillPoints -= 1;
                player.skills[sk.id] = (player.skills[sk.id] || 0) + 1;
                updateExpHUD();
                renderSkillTreeUI();
                renderBuffBar();
                showToast(`📘 ${sk.name} Seviye ${player.skills[sk.id]} oldu!`, '#ffd166');
            }
        };
    });
}

['rod', 'bait', 'costume'].forEach(slotType => {
    document.getElementById(`slot-${slotType}`).addEventListener('click', () => {
        if (player.equipped[slotType]) {
            const oldItem = ITEMS[player.equipped[slotType]];
            player.equipped[slotType] = null;
            if (slotType === 'rod') {
                player.equipped.rodUid = null;
                if (autoHunt.active) stopAutoHunt('Olta çıkarıldığı için Auto-Hunt durdu.');
                if (fishing.state !== 'IDLE') cancelFishing('Oltayı çıkardığın için balık tutma durdu.');
            }
            showToast(`${oldItem.name} çıkarıldı.`);
            renderInventoryUI();
            renderBuffBar();
        }
    });
});

function handleInventoryItemClick(invEntry) {
    if (!invEntry) return;
    const item = ITEMS[invEntry.id];
    if (!item) return;

    if (item.type === 'rod') {
        const isSameEquipped = (invEntry.uid && player.equipped.rodUid === invEntry.uid) ||
                               (!invEntry.uid && player.equipped.rod === item.id);
        if (isSameEquipped) {
            player.equipped.rod = null;
            player.equipped.rodUid = null;
            if (autoHunt.active) stopAutoHunt('Olta çıkarıldığı için Auto-Hunt durdu.');
            if (fishing.state !== 'IDLE') cancelFishing('Oltayı çıkardığın için balık tutma durdu.');
            showToast(`${item.name} çıkarıldı.`);
        } else {
            player.equipped.rod = item.id;
            player.equipped.rodUid = invEntry.uid || null;
            const e = getEntryEnchants(invEntry);
            const plusStr = e.count > 0 ? ` (+${e.count})` : '';
            showToast(`${item.name}${plusStr} kuşandı!`, '#52b788');
        }
        renderInventoryUI();
        renderBuffBar();
    } else if (item.type === 'costume') {
        const isSameEquipped = (invEntry.uid && player.equipped.costumeUid === invEntry.uid) ||
                               (!invEntry.uid && player.equipped.costume === item.id);
        if (isSameEquipped) {
            player.equipped.costume = null;
            player.equipped.costumeUid = null;
            showToast(`${item.name} çıkarıldı.`);
        } else {
            if (!invEntry.uid) invEntry.uid = generateItemUid();
            player.equipped.costume = item.id;
            player.equipped.costumeUid = invEntry.uid;
            const e = getEntryEnchants(invEntry);
            const plusStr = e && e.count > 0 ? ` (+${e.count})` : '';
            showToast(`${item.name}${plusStr} kuşandı!`, '#52b788');
        }
        renderInventoryUI();
        renderBuffBar();
    } else if (item.type === 'bait') {
        if (player.equipped.bait === item.id) {
            player.equipped.bait = null;
            showToast(`${item.name} çıkarıldı.`);
        } else {
            player.equipped.bait = item.id;
            showToast(`${item.name} kuşandı!`, '#52b788');
        }
        renderInventoryUI();
    } else if (item.type === 'cooked_fish') {
        removeItemFromInventory(item.id, 1);
        activateCookedFishBuff(item);
        renderInventoryUI();
    } else if (item.type === 'scroll') {
        showToast('💡 Efsun kağıtlarını Dörtyol\'daki Efsunlu Örs (Anvil) üzerinde olta veya kostümüne basabilirsin!', '#c77dff');
    } else if (item.type === 'material') {
        showToast(`💎 ${item.name}: Özel craft ve dönüştürmelerde kullanılır!`, '#90e0ef');
    }
}

function getRodEnchantSummary(entryOrRodId) {
    let e = null;
    if (typeof entryOrRodId === 'object' && entryOrRodId !== null) {
        e = getEntryEnchants(entryOrRodId);
    } else if (typeof entryOrRodId === 'string') {
        e = player.rodEnchants[entryOrRodId] || player.costumeEnchants?.[entryOrRodId];
    }
    if (!e || e.count === 0) return `Efsun: 0 / ${MAX_ENCHANT_COUNT} (Henüz efsun basılmamış)`;
    const parts = [];
    if (e.luck > 0) parts.push(`+%${e.luck} Şans`);
    if (e.speed > 0) parts.push(`-%${e.speed} Süre`);
    if (e.control > 0) parts.push(`-%${e.control} Bar Hızı`);
    return `✨ Efsun (+${e.count}/${MAX_ENCHANT_COUNT}): ${parts.join(' • ')}`;
}

let isTrashMode = false;
let selectedTrashIndices = new Set();

function executeTrashDelete() {
    if (selectedTrashIndices.size === 0) {
        showToast('⚠️ Lütfen silmek istediğin en az bir eşya seç!', '#ff595e');
        return;
    }
    const count = selectedTrashIndices.size;
    const itemNames = [];
    selectedTrashIndices.forEach(idx => {
        const entry = player.inventory[idx];
        if (entry && ITEMS[entry.id]) {
            const e = getEntryEnchants(entry);
            const plus = e && e.count > 0 ? ` (+${e.count})` : '';
            itemNames.push(`${ITEMS[entry.id].name}${plus}${entry.count > 1 ? ` x${entry.count}` : ''}`);
        }
    });

    const msg = `Seçtiğin şu ${count} adet eşyayı envanterinden kalıcı olarak SİLMEK istediğine emin misin?\n\n• ` + itemNames.join('\n• ');
    if (!confirm(msg)) {
        return;
    }

    const sortedIndices = Array.from(selectedTrashIndices).sort((a, b) => b - a);
    sortedIndices.forEach(idx => {
        if (idx >= 0 && idx < player.inventory.length) {
            const entry = player.inventory[idx];
            if (entry.uid) {
                if (player.equipped.rodUid === entry.uid) {
                    player.equipped.rod = null;
                    player.equipped.rodUid = null;
                }
                if (player.equipped.costumeUid === entry.uid) {
                    player.equipped.costume = null;
                    player.equipped.costumeUid = null;
                }
                if (anvilState.rodUid === entry.uid) anvilState.rodUid = null;
                if (anvilState.itemUid === entry.uid) anvilState.itemUid = null;
            } else {
                if (player.equipped.bait === entry.id) player.equipped.bait = null;
                if (player.equipped.rod === entry.id) player.equipped.rod = null;
                if (player.equipped.costume === entry.id) player.equipped.costume = null;
            }
            player.inventory.splice(idx, 1);
        }
    });

    selectedTrashIndices.clear();
    isTrashMode = false;
    showToast(`🗑️ ${count} adet eşya envanterden silindi.`, '#ffbe0b');
    renderInventoryUI();
    renderBuffBar();
}

function renderInventoryUI() {
    ['rod', 'bait', 'costume'].forEach(slotType => {
        const slotEl = document.getElementById(`slot-${slotType}`);
        const iconHolder = slotEl.querySelector('.slot-item-icon');
        const nameEl = document.getElementById(`name-${slotType}`);
        iconHolder.innerHTML = '';

        const eqId = player.equipped[slotType];
        if (eqId && ITEMS[eqId]) {
            const item = ITEMS[eqId];
            slotEl.classList.add('equipped');
            if (item.isSOS || item.isRoyal) {
                slotEl.classList.add('sos-slot');
            } else {
                slotEl.classList.remove('sos-slot');
            }
            iconHolder.appendChild(createItemIconCanvas(item));
            if (slotType === 'rod') {
                const eqEntry = getEquippedRodEntry();
                const e = getEntryEnchants(eqEntry);
                nameEl.textContent = e.count > 0 ? `${item.name} (+${e.count})` : item.name;
            } else if (slotType === 'costume') {
                const eqEntry = getEquippedCostumeEntry();
                const e = getEntryEnchants(eqEntry);
                nameEl.textContent = e && e.count > 0 ? `${item.name} (+${e.count})` : item.name;
            } else {
                nameEl.textContent = item.name;
            }
        } else {
            slotEl.classList.remove('equipped');
            slotEl.classList.remove('sos-slot');
            nameEl.textContent = 'Boş (Çıkarıldı)';
        }
    });

    const stats = getPlayerFishingStats();
    document.getElementById('player-stats-summary').innerHTML = `
        <div>🍀 Nadirlik Şansı Artışı: <b>+%${stats.luckPct.toFixed(0)}</b></div>
        <div>⚡ Balık Tutma Süresi Kısalma: <b>-%${stats.speedPct.toFixed(0)}</b></div>
        <div>🎯 Bar Hareket Yavaşlatma: <b>-%${stats.barSlowPct.toFixed(0)}</b></div>
    `;

    // Çöp Kutusu Buton & Bar Kontrolleri
    const trashBtn = document.getElementById('inv-trash-toggle-btn');
    const trashBar = document.getElementById('trash-action-bar');
    const trashCountText = document.getElementById('trash-count-text');
    const bagSubhint = document.getElementById('bag-subhint-text');

    if (trashBtn) {
        trashBtn.onclick = () => {
            isTrashMode = !isTrashMode;
            selectedTrashIndices.clear();
            renderInventoryUI();
        };
        if (isTrashMode) {
            trashBtn.classList.add('active');
            trashBtn.textContent = '🗑️ Çöp Modu (Açık)';
        } else {
            trashBtn.classList.remove('active');
            trashBtn.textContent = '🗑️ Çöp Kutusu';
        }
    }

    if (trashBar) {
        if (isTrashMode) {
            trashBar.classList.remove('hidden');
        } else {
            trashBar.classList.add('hidden');
        }
    }

    if (trashCountText) {
        trashCountText.textContent = `${selectedTrashIndices.size} eşya seçildi`;
    }

    if (bagSubhint) {
        if (isTrashMode) {
            bagSubhint.innerHTML = '<b style="color:#ff595e;">Silinecek eşyaları seç, aşağıdan "Seçilenleri Sil"e bas</b>';
        } else {
            bagSubhint.textContent = 'Kuşanmak veya yemek için eşyaya tıkla';
        }
    }

    const trashDelBtn = document.getElementById('trash-delete-btn');
    if (trashDelBtn) {
        trashDelBtn.disabled = selectedTrashIndices.size === 0;
        trashDelBtn.onclick = () => {
            executeTrashDelete();
        };
    }

    const trashCancelBtn = document.getElementById('trash-cancel-btn');
    if (trashCancelBtn) {
        trashCancelBtn.onclick = () => {
            isTrashMode = false;
            selectedTrashIndices.clear();
            renderInventoryUI();
        };
    }

    const bagGrid = document.getElementById('bag-grid');
    bagGrid.innerHTML = '';

    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';

        const invEntry = player.inventory[i];
        if (invEntry && ITEMS[invEntry.id]) {
            const item = ITEMS[invEntry.id];
            const iconWrap = document.createElement('div');
            iconWrap.className = 'slot-item-icon';
            iconWrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(iconWrap);

            if (invEntry.count > 1) {
                const countSpan = document.createElement('span');
                countSpan.className = 'item-count';
                countSpan.textContent = `x${invEntry.count}`;
                slotDiv.appendChild(countSpan);
            }

            const isEquipped =
                (item.type === 'rod' && ((invEntry.uid && player.equipped.rodUid === invEntry.uid) || (!invEntry.uid && player.equipped.rod === item.id))) ||
                (item.type === 'costume' && ((invEntry.uid && player.equipped.costumeUid === invEntry.uid) || (!invEntry.uid && player.equipped.costume === item.id))) ||
                (item.type === 'bait' && player.equipped.bait === item.id);

            if (isEquipped) {
                const badge = document.createElement('span');
                badge.className = 'equipped-badge';
                badge.textContent = 'E';
                slotDiv.appendChild(badge);
            }

            if (item.type === 'rod' || item.type === 'costume') {
                const e = getEntryEnchants(invEntry);
                if (e && e.count > 0) {
                    const eb = document.createElement('span');
                    eb.className = 'enchant-badge';
                    eb.textContent = `+${e.count}`;
                    slotDiv.appendChild(eb);
                }
            }

            if (item.isSOS || item.isRoyal) {
                slotDiv.classList.add('sos-slot');
                const sosTag = document.createElement('span');
                sosTag.className = 'sos-badge';
                sosTag.textContent = item.isRoyal ? 'KRALİYET' : 'SOS';
                slotDiv.appendChild(sosTag);

                const sparkles = document.createElement('div');
                sparkles.className = 'sos-sparkles';
                sparkles.innerHTML = `
                    <span class="sos-star-p s1">✦</span>
                    <span class="sos-star-p s2">★</span>
                    <span class="sos-star-p s3">✦</span>
                    <span class="sos-star-p s4">★</span>
                `;
                slotDiv.appendChild(sparkles);
            }

            slotDiv.addEventListener('mouseenter', () => {
                const e = (item.type === 'rod' || item.type === 'costume') ? getEntryEnchants(invEntry) : null;
                let plusTitle = e && e.count > 0 ? `${item.name} (+${e.count})` : item.name;
                if (item.isRoyal) plusTitle = `👑 ${plusTitle} [KRALİYET]`;
                else if (item.isSOS) plusTitle = `🌟 ${plusTitle} [SEAL OF STAR]`;
                document.getElementById('tt-title').textContent = plusTitle;
                document.getElementById('tt-type').textContent = item.typeName;
                document.getElementById('tt-desc').textContent = item.desc;
                let enchantText = '';
                if (item.type === 'rod' || item.type === 'costume') {
                    enchantText = getRodEnchantSummary(invEntry);
                }
                if (item.rareFishBonus || item.fishSpeedBonus || item.baitProtectBonus) {
                    const perks = [];
                    if (item.rareFishBonus) perks.push(`+%${item.rareFishBonus} Nadir Balık`);
                    if (item.fishSpeedBonus) perks.push(`+%${item.fishSpeedBonus} Hız`);
                    if (item.autoHuntSpeedBonus) perks.push(`+%${item.autoHuntSpeedBonus} Auto-Hunt`);
                    if (item.baitProtectBonus) perks.push(`%${item.baitProtectBonus} Yem Koruma`);
                    if (item.buffDurationBonus) perks.push(`+%${item.buffDurationBonus} Buff Süresi`);
                    if (item.anvilBonus) perks.push(`+%${item.anvilBonus} Anvil`);
                    if (item.gamblerBonus) perks.push(`+%${item.gamblerBonus} Bahisçi`);
                    enchantText = `👑 [Nitelikler]: ${perks.join(' • ')}\n${enchantText}`;
                }
                document.getElementById('tt-enchants').textContent = enchantText;
            });

            if (isTrashMode) {
                if (selectedTrashIndices.has(i)) {
                    slotDiv.classList.add('trash-selected');
                    const trashBadge = document.createElement('span');
                    trashBadge.className = 'trash-check-badge';
                    trashBadge.textContent = '✕';
                    slotDiv.appendChild(trashBadge);
                }
                slotDiv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (selectedTrashIndices.has(i)) {
                        selectedTrashIndices.delete(i);
                    } else {
                        selectedTrashIndices.add(i);
                    }
                    renderInventoryUI();
                });
            } else {
                slotDiv.addEventListener('click', () => handleInventoryItemClick(invEntry));
            }
        }

        bagGrid.appendChild(slotDiv);
    }

    drawCharacterPreview();
}

// ============================================================================
// 8. ŞEHİR NPC'LERİ & IŞINLANMA TAŞI MODALLARI
// ============================================================================
let fishermanRightTab = 'sell'; // 'sell' | 'buyback'
let alchemistRightTab = 'bag';  // 'bag'  | 'buyback'

function interactWithObject(inter) {
    if (autoHunt.active) stopAutoHunt();
    cancelFishing();

    if (inter.type === 'teleport') {
        currentMapId = inter.targetMap;
        player.x = inter.targetX;
        player.y = inter.targetY;
        player.path = [];
        player.targetMarker = null;
        showToast(`💠 ${getActiveMap().name} bölgesine ışınlandın!`, '#4cc9f0');
        return;
    }

    const modal = document.getElementById('npc-modal');
    const iconEl = document.getElementById('npc-modal-icon');
    const titleEl = document.getElementById('npc-modal-title');
    const subEl = document.getElementById('npc-modal-subtitle');
    const contentEl = document.getElementById('npc-modal-content');

    document.getElementById('inventory-modal').classList.add('hidden');
    document.getElementById('skill-modal').classList.add('hidden');
    modal.classList.remove('hidden');

    titleEl.textContent = inter.name;
    subEl.textContent = inter.subtitle || '';

    if (inter.type === 'storage') {
        iconEl.textContent = '📦';
        renderStorageModal(contentEl);
    } else if (inter.type === 'fisherman') {
        iconEl.textContent = '🎣';
        renderFishermanModal(contentEl);
    } else if (inter.type === 'alchemist') {
        iconEl.textContent = '⚗️';
        renderAlchemistModal(contentEl);
    } else if (inter.type === 'carpenter') {
        iconEl.textContent = '🪚';
        renderCarpenterModal(contentEl);
    } else if (inter.type === 'chef') {
        iconEl.textContent = '👨‍🍳';
        renderChefModal(contentEl);
    } else if (inter.type === 'anvil') {
        iconEl.textContent = '🔨';
        // Anvil açıldığında otomatik olarak eldeki oltayı seçmez; oyuncu envanterinden kendisi koyar!
        anvilState.rodUid = null;
        anvilState.scrollId = null;
        anvilState.protectScrollId = null;
        anvilState.isForging = false;
        renderAnvilModal(contentEl);
    } else if (inter.type === 'gambler') {
        iconEl.textContent = '🎲';
        gamblerState.treasurePlaced = false;
        gamblerState.isOpening = false;
        renderGamblerModal(contentEl);
    } else if (inter.type === 'shipyard') {
        iconEl.textContent = '⛵';
        renderShipyardModal(contentEl);
    } else if (inter.type === 'headman') {
        iconEl.textContent = '📜';
        renderHeadmanModal(contentEl);
    } else if (inter.type === 'guild') {
        iconEl.textContent = '🏛️';
        renderGuildNPCModal(contentEl);
    } else if (inter.type === 'guild_guard') {
        iconEl.textContent = '🛡️';
        renderGuildGuardModal(contentEl);
    } else if (inter.type === 'tailor') {
        iconEl.textContent = '🧵';
        renderTailorModal(contentEl);
    } else if (inter.type === 'market') {
        iconEl.textContent = '⚖️';
        renderMarketModal(contentEl);
    }
}

// KOSTÜMCÜ SELİM (Korsan ve Balıkçı Temalı Kostüm Mağazası)
function renderTailorModal(container) {
    const costumeIds = [
        'costume_sea_dog',
        'costume_buccaneer',
        'costume_deep_diver',
        'costume_corsair',
        'costume_master_angler'
    ];

    let cardsHtml = '';
    costumeIds.forEach(cid => {
        const item = ITEMS[cid];
        if (!item) return;

        const ownedCount = player.inventory.filter(i => i.id === cid).length;
        const isEquipped = player.equipped.costume === cid;
        const price = item.buyPrice || 500;
        const canAfford = player.gold >= price;
        const isBagFull = player.inventory.length >= 24;

        let statusBadge = '';
        if (isEquipped) {
            statusBadge = `<span style="font-size:11px; background:rgba(46,196,182,0.2); color:#2ec4b6; border:1px solid #2ec4b6; padding:2px 6px; border-radius:4px;">Kuşanıldı</span>`;
        } else if (ownedCount > 0) {
            statusBadge = `<span style="font-size:11px; background:rgba(255,190,11,0.2); color:#ffd166; border:1px solid #ffd166; padding:2px 6px; border-radius:4px;">Çantanda (x${ownedCount})</span>`;
        }

        cardsHtml += `
            <div class="shop-card" style="margin-bottom:10px; align-items:center;">
                <div class="shop-card-left">
                    <div id="tailor-icon-${cid}"></div>
                    <div style="flex:1;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-weight:700; color:#ffd166; font-size:13.5px;">${item.name}</span>
                            <span style="font-size:10.5px; color:#adb5bd; background:rgba(255,255,255,0.06); padding:1px 5px; border-radius:3px;">${item.typeName}</span>
                            ${statusBadge}
                        </div>
                        <div style="font-size:11.5px; color:#ced4da; margin-top:3px; line-height:1.4;">
                            ${item.desc}
                        </div>
                    </div>
                </div>
                <div class="shop-card-right" style="gap:6px;">
                    <span class="price-tag" style="border-color:${canAfford ? '#ffd166' : '#ff595e'}; color:${canAfford ? '#ffd166' : '#ff595e'}; font-size:12px;">
                        🪙 ${price} Altın
                    </span>
                    <button class="action-btn success tailor-buy-btn" data-costume="${cid}" ${(!canAfford || isBagFull) ? 'disabled' : ''} style="padding:6px 14px; font-size:12px; font-weight:700;">
                        ${isBagFull ? 'Çanta Dolu' : !canAfford ? 'Yetersiz Altın' : '🛒 Satın Al'}
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="npc-panel">
            <div class="npc-panel-header">
                <div>
                    <h3>🧵 Kostümcü Selim (Korsan & Usta Balıkçı Terzisi)</h3>
                    <div style="font-size:12px; color:#adb5bd; margin-top:3px;">
                        Tüm kostümler <b>Efsunlu Örs'te +5'e kadar</b> güçlendirilebilir! Yeni bir kostüm satın alarak görünüşünü ve niteliklerini zenginleştir.
                    </div>
                </div>
                <span class="price-tag">🪙 ${player.gold} Altın</span>
            </div>
            <div style="margin-top:10px;">
                ${cardsHtml}
            </div>
        </div>
    `;

    // İkonları canvas olarak bağla
    costumeIds.forEach(cid => {
        const iconEl = document.getElementById(`tailor-icon-${cid}`);
        const it = ITEMS[cid];
        if (iconEl && it) {
            iconEl.appendChild(createItemIconCanvas(it));
        }
    });

    // Satın Alma İşlemi
    container.querySelectorAll('.tailor-buy-btn').forEach(btn => {
        btn.onclick = () => {
            const cid = btn.getAttribute('data-costume');
            const item = ITEMS[cid];
            if (!item) return;
            const price = item.buyPrice || 500;
            if (player.gold < price) {
                showToast('⚠️ Bu kostümü almak için yeterli altının yok!', '#ff595e');
                return;
            }
            if (player.inventory.length >= 24) {
                showToast('⚠️ Çantan dolu! Envanterinde en az 1 boş slot olmalıdır.', '#ff595e');
                return;
            }
            player.gold -= price;
            addItemToInventory(cid, 1);
            showToast(`🎉 [${item.name}] başarıyla satın alındı ve çantana eklendi!`, '#80ed99');
            updateExpHUD();
            renderInventoryUI();
            renderTailorModal(container);
        };
    });
}

// ============================================================================
// DÖRTYOL PAZARI (AUCTION HOUSE & AÇIK ARTIRMA PAZARI)
// ============================================================================
let marketActiveTab = 'buy'; // 'buy' (İtem Al) | 'sell' (İtem Sat)
let marketCategoryFilter = 'all';
let marketSearchQuery = '';
let marketOnlyMyListings = false;
let marketSortOption = 'cheapest';
let marketSelectedSellIndex = null;
let marketSellCount = 1;
let marketSellPrice = 100;

const DEFAULT_MARKET_LISTINGS = [
    {
        id: 'list_seed_1',
        sellerName: 'Balıkçı Kenan',
        isPlayerListing: false,
        itemId: 'fish_carp',
        count: 5,
        pricePerUnit: 35,
        totalPrice: 175,
        createdAt: Date.now() - 3600000,
        enchants: null
    },
    {
        id: 'list_seed_2',
        sellerName: 'Kaptan Levent',
        isPlayerListing: false,
        itemId: 'rod_oak',
        count: 1,
        pricePerUnit: 450,
        totalPrice: 450,
        createdAt: Date.now() - 7200000,
        enchants: { count: 2, luck: 4, speed: 4, control: 2 }
    },
    {
        id: 'list_seed_3',
        sellerName: 'Tüccar Selami',
        isPlayerListing: false,
        itemId: 'item_pearl',
        count: 2,
        pricePerUnit: 850,
        totalPrice: 1700,
        createdAt: Date.now() - 10800000,
        enchants: null
    },
    {
        id: 'list_seed_4',
        sellerName: 'Dalgıç Murat',
        isPlayerListing: false,
        itemId: 'bait_squid',
        count: 15,
        pricePerUnit: 15,
        totalPrice: 225,
        createdAt: Date.now() - 5400000,
        enchants: null
    },
    {
        id: 'list_seed_5',
        sellerName: 'Simyacı Çırağı',
        isPlayerListing: false,
        itemId: 'scroll_basic',
        count: 3,
        pricePerUnit: 300,
        totalPrice: 900,
        createdAt: Date.now() - 1800000,
        enchants: null
    },
    {
        id: 'list_seed_6',
        sellerName: 'Eski Denizci',
        isPlayerListing: false,
        itemId: 'costume_sea_dog',
        count: 1,
        pricePerUnit: 2200,
        totalPrice: 2200,
        createdAt: Date.now() - 14400000,
        enchants: { count: 1, luck: 2, speed: 2, control: 0 }
    }
];

let marketListings = (() => {
    try {
        const raw = localStorage.getItem('mmo_market_listings');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {}
    return [...DEFAULT_MARKET_LISTINGS];
})();

function saveMarketData() {
    try {
        localStorage.setItem('mmo_market_listings', JSON.stringify(marketListings));
    } catch (e) {}
}

function renderMarketModal(container) {
    container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;">
            <div class="tab-group market-header-tabs">
                <button class="tab-btn ${marketActiveTab === 'buy' ? 'active' : ''}" id="mkt-tab-buy">🛒 İtem Al (Pazardaki Eşyalar)</button>
                <button class="tab-btn ${marketActiveTab === 'sell' ? 'active' : ''}" id="mkt-tab-sell">🏷️ İtem Sat (Pazara İlan Ver)</button>
            </div>
            <div class="price-tag" style="font-size: 13px; font-weight: 700; color: #ffd166;">
                🪙 ${player.gold.toLocaleString('tr-TR')} Altın
            </div>
        </div>
        <div id="market-tab-content"></div>
    `;

    document.getElementById('mkt-tab-buy').onclick = () => {
        marketActiveTab = 'buy';
        renderMarketModal(container);
    };

    document.getElementById('mkt-tab-sell').onclick = () => {
        marketActiveTab = 'sell';
        renderMarketModal(container);
    };

    const tabContainer = document.getElementById('market-tab-content');
    if (marketActiveTab === 'buy') {
        renderMarketBuyTab(tabContainer, container);
    } else {
        renderMarketSellTab(tabContainer, container);
    }
}

function renderMarketBuyTab(tabContainer, mainContainer) {
    let filtered = marketListings.filter(l => {
        const it = ITEMS[l.itemId];
        if (!it) return false;

        if (marketSearchQuery) {
            const q = marketSearchQuery.toLowerCase();
            const nameMatch = it.name.toLowerCase().includes(q);
            const sellerMatch = (l.sellerName || '').toLowerCase().includes(q);
            if (!nameMatch && !sellerMatch) return false;
        }

        if (marketCategoryFilter !== 'all') {
            if (marketCategoryFilter === 'fish' && it.type !== 'fish') return false;
            if (marketCategoryFilter === 'gear' && it.type !== 'rod' && it.type !== 'costume') return false;
            if (marketCategoryFilter === 'scroll' && it.type !== 'scroll' && it.type !== 'material') return false;
            if (marketCategoryFilter === 'bait' && it.type !== 'bait' && it.type !== 'cooked_fish') return false;
        }

        if (marketOnlyMyListings) {
            const isMine = l.isPlayerListing || (l.sellerName === player.name && l.sellerName !== 'Oyuncu');
            if (!isMine) return false;
        }

        return true;
    });

    if (marketSortOption === 'cheapest') {
        filtered.sort((a, b) => a.totalPrice - b.totalPrice);
    } else if (marketSortOption === 'expensive') {
        filtered.sort((a, b) => b.totalPrice - a.totalPrice);
    } else if (marketSortOption === 'newest') {
        filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    tabContainer.innerHTML = `
        <div class="market-filter-bar">
            <div class="market-search-box">
                <input type="text" class="market-search-input" id="mkt-search" placeholder="🔍 Eşya veya satıcı ara..." value="${escapeHTML(marketSearchQuery)}">
            </div>
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
                <button class="market-cat-btn ${marketCategoryFilter === 'all' ? 'active' : ''}" data-cat="all">Tümü</button>
                <button class="market-cat-btn ${marketCategoryFilter === 'fish' ? 'active' : ''}" data-cat="fish">🐟 Balıklar</button>
                <button class="market-cat-btn ${marketCategoryFilter === 'gear' ? 'active' : ''}" data-cat="gear">🎣 Oltalar & Kostümler</button>
                <button class="market-cat-btn ${marketCategoryFilter === 'scroll' ? 'active' : ''}" data-cat="scroll">📜 Parşömen & İnci</button>
                <button class="market-cat-btn ${marketCategoryFilter === 'bait' ? 'active' : ''}" data-cat="bait">🪱 Yemler</button>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <select class="market-sort-select" id="mkt-sort">
                    <option value="cheapest" ${marketSortOption === 'cheapest' ? 'selected' : ''}>Fiyat (En Düşük)</option>
                    <option value="expensive" ${marketSortOption === 'expensive' ? 'selected' : ''}>Fiyat (En Yüksek)</option>
                    <option value="newest" ${marketSortOption === 'newest' ? 'selected' : ''}>En Yeni</option>
                </select>
                <label class="market-only-mine-label">
                    <input type="checkbox" id="mkt-mine-chk" ${marketOnlyMyListings ? 'checked' : ''}>
                    <span>Sadece İlanlarım</span>
                </label>
            </div>
        </div>

        <div class="shop-list" id="market-listings-list" style="max-height: 380px;"></div>
    `;

    const searchInput = document.getElementById('mkt-search');
    if (searchInput) {
        searchInput.oninput = (e) => {
            marketSearchQuery = e.target.value;
            renderMarketBuyTab(tabContainer, mainContainer);
        };
    }

    document.querySelectorAll('.market-cat-btn').forEach(btn => {
        btn.onclick = () => {
            marketCategoryFilter = btn.getAttribute('data-cat');
            renderMarketBuyTab(tabContainer, mainContainer);
        };
    });

    const sortSelect = document.getElementById('mkt-sort');
    if (sortSelect) {
        sortSelect.onchange = (e) => {
            marketSortOption = e.target.value;
            renderMarketBuyTab(tabContainer, mainContainer);
        };
    }

    const mineChk = document.getElementById('mkt-mine-chk');
    if (mineChk) {
        mineChk.onchange = (e) => {
            marketOnlyMyListings = e.target.checked;
            renderMarketBuyTab(tabContainer, mainContainer);
        };
    }

    const listEl = document.getElementById('market-listings-list');
    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
                <div style="font-size: 32px; margin-bottom: 8px;">🛍️</div>
                <div style="font-weight: 700; color: #ffd166; margin-bottom: 4px;">Pazar Şuan Sessiz</div>
                <div style="font-size: 12px;">Arama kriterlerine uygun ilan bulunamadı veya henüz listelenmiş eşya yok.</div>
                <button class="action-btn" id="mkt-empty-sell-btn" style="margin-top: 14px;">🏷️ İlk İlanı Sen Ver!</button>
            </div>
        `;
        document.getElementById('mkt-empty-sell-btn')?.addEventListener('click', () => {
            marketActiveTab = 'sell';
            renderMarketModal(mainContainer);
        });
        return;
    }

    filtered.forEach(l => {
        const it = ITEMS[l.itemId];
        if (!it) return;

        const isMine = l.isPlayerListing || (l.sellerName === player.name && l.sellerName !== 'Oyuncu');
        const card = document.createElement('div');
        card.className = `market-listing-card ${isMine ? 'mine-card' : ''}`;

        const iconWrap = document.createElement('div');
        iconWrap.style.cssText = 'position:relative; width:48px; height:48px; background:#0f141e; border:1.5px solid #5c677d; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0;';
        if (it.isRoyal || it.isSOS) iconWrap.classList.add('sos-slot');
        iconWrap.appendChild(createItemIconCanvas(it));

        if (l.count > 1) {
            const countBadge = document.createElement('span');
            countBadge.className = 'item-count';
            countBadge.textContent = `x${l.count}`;
            iconWrap.appendChild(countBadge);
        }
        if ((it.type === 'rod' || it.type === 'costume') && l.enchants && l.enchants.count > 0) {
            const enchBadge = document.createElement('span');
            enchBadge.className = 'enchant-badge';
            enchBadge.textContent = `+${l.enchants.count}`;
            iconWrap.appendChild(enchBadge);
        }

        const plusStr = (l.enchants && l.enchants.count > 0) ? ` (+${l.enchants.count})` : '';
        const titleColor = it.color || '#fff';

        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'flex: 1; min-width: 0;';
        infoDiv.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; margin-bottom: 2px;">
                <span style="font-weight: 800; font-size: 13.5px; color: ${titleColor};">${it.name}${plusStr}</span>
                ${isMine ? '<span class="wiki-badge" style="background:#00f5d4; color:#000; font-size:10px;">SENİN İLANIN</span>' : ''}
            </div>
            <div style="display:flex; gap:10px; font-size:11px; color:#94a3b8;">
                <span class="market-seller-tag ${isMine ? 'mine' : ''}">👤 Satıcı: <b>${l.sellerName}</b></span>
                <span>•</span>
                <span>Adet: <b style="color:#f1f5f9;">${l.count}</b></span>
                <span>•</span>
                <span>Birim: 🪙 ${l.pricePerUnit.toLocaleString('tr-TR')}</span>
            </div>
        `;

        const actionDiv = document.createElement('div');
        actionDiv.style.cssText = 'display:flex; align-items:center; gap:14px;';
        actionDiv.innerHTML = `
            <div class="market-price-box">
                <span class="market-total-price">🪙 ${l.totalPrice.toLocaleString('tr-TR')} Altın</span>
                <span class="market-unit-price">${l.count > 1 ? `(${l.pricePerUnit} / adet)` : ''}</span>
            </div>
            <button class="action-btn ${isMine ? 'danger-btn' : 'success'}" id="btn-mkt-act-${l.id}" style="white-space:nowrap; padding: 6px 14px;">
                ${isMine ? '📦 İlanı Kaldır' : '💰 Satın Al'}
            </button>
        `;

        card.appendChild(iconWrap);
        card.appendChild(infoDiv);
        card.appendChild(actionDiv);
        listEl.appendChild(card);

        const actBtn = document.getElementById(`btn-mkt-act-${l.id}`);
        if (actBtn) {
            actBtn.onclick = () => {
                if (isMine) {
                    if (player.inventory.length >= 24) {
                        showToast('⚠️ Çantan dolu! İlanı geri çekmek için çantanda en az 1 boş slot olmalıdır.', '#ff595e');
                        return;
                    }
                    if (addItemToInventory(l.itemId, l.count, l.enchants || null)) {
                        marketListings = marketListings.filter(item => item.id !== l.id);
                        saveMarketData();
                        showToast(`📦 [${it.name}${plusStr}] ilanı pazardan kaldırıldı ve çantana iade edildi.`, '#4cc9f0');
                        renderMarketModal(mainContainer);
                    } else {
                        showToast('⚠️ Eşya çantaya aktarılamadı!', '#ff595e');
                    }
                } else {
                    if (player.gold < l.totalPrice) {
                        showToast(`⚠️ Yetersiz altın! Bu ilanı satın almak için ${l.totalPrice} altına ihtiyacın var.`, '#ff595e');
                        return;
                    }
                    if (player.inventory.length >= 24) {
                        const canStack = (it.type !== 'rod' && it.type !== 'costume') && player.inventory.some(e => e.id === l.itemId);
                        if (!canStack) {
                            showToast('⚠️ Çantan dolu! Satın almadan önce çantanda yer açmalısın.', '#ff595e');
                            return;
                        }
                    }
                    player.gold -= l.totalPrice;
                    addItemToInventory(l.itemId, l.count, l.enchants || null);
                    marketListings = marketListings.filter(item => item.id !== l.id);
                    saveMarketData();
                    updateExpHUD();
                    showToast(`🎉 [${it.name}${plusStr} x${l.count}] pazardan ${l.totalPrice} altına satın alındı!`, '#52b788');
                    addChatMessage('Pazar', `Pazardan [${it.name}${plusStr} x${l.count}] satın aldın (-${l.totalPrice} Altın).`, 'system');
                    renderMarketModal(mainContainer);
                }
            };
        }
    });
}

function renderMarketSellTab(tabContainer, mainContainer) {
    tabContainer.innerHTML = `
        <div class="npc-split">
            <!-- Sol Panel: Oyuncunun Çantası -->
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🎒 Satılacak Eşyayı Seç (${player.inventory.length} / 24)</h3>
                </div>
                <div class="slot-grid" id="market-sell-bag-grid"></div>
                <div class="bag-subhint" style="margin-top: 10px;">
                    Pazara koymak istediğin eşyanın üzerine tıkla.
                </div>
            </div>

            <!-- Sağ Panel: İlan Detay Formu -->
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🏷️ İlan Verme Formu</h3>
                </div>
                <div id="market-sell-form-wrap"></div>
            </div>
        </div>
    `;

    const bagGrid = document.getElementById('market-sell-bag-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';
        if (marketSelectedSellIndex === i) {
            slotDiv.classList.add('market-slot-selected');
        }

        const entry = player.inventory[i];
        if (entry && ITEMS[entry.id]) {
            const it = ITEMS[entry.id];
            const iconWrap = document.createElement('div');
            iconWrap.className = 'slot-item-icon';
            iconWrap.appendChild(createItemIconCanvas(it));
            slotDiv.appendChild(iconWrap);

            if (entry.count > 1) {
                const countBadge = document.createElement('span');
                countBadge.className = 'item-count';
                countBadge.textContent = `x${entry.count}`;
                slotDiv.appendChild(countBadge);
            }

            if (it.type === 'rod' || it.type === 'costume') {
                const e = getEntryEnchants(entry);
                if (e && e.count > 0) {
                    const eb = document.createElement('span');
                    eb.className = 'enchant-badge';
                    eb.textContent = `+${e.count}`;
                    slotDiv.appendChild(eb);
                }
            }

            if (it.isRoyal || it.isSOS) {
                slotDiv.classList.add('sos-slot');
            }

            slotDiv.onclick = () => {
                marketSelectedSellIndex = i;
                marketSellCount = 1;
                const base = it.sellPrice || (it.buyPrice ? Math.floor(it.buyPrice * 0.7) : 50);
                marketSellPrice = Math.max(10, base);
                renderMarketSellTab(tabContainer, mainContainer);
            };
        }
        bagGrid.appendChild(slotDiv);
    }

    const formWrap = document.getElementById('market-sell-form-wrap');
    const selEntry = marketSelectedSellIndex !== null ? player.inventory[marketSelectedSellIndex] : null;

    if (!selEntry || !ITEMS[selEntry.id]) {
        formWrap.innerHTML = `
            <div style="text-align: center; padding: 45px 14px; color: #94a3b8;">
                <div style="font-size: 36px; margin-bottom: 10px;">📦</div>
                <div style="font-weight: 700; color: #ffd166; font-size: 14px; margin-bottom: 6px;">Eşya Seçilmedi</div>
                <div style="font-size: 12px; line-height: 1.5;">Sol taraftaki çantandan pazara ilan vermek istediğin eşyayı seç. İster 1 adet ister tüm stoğunu istediğin fiyattan satabilirsin!</div>
            </div>
        `;
        return;
    }

    const it = ITEMS[selEntry.id];
    const isEquip = (it.type === 'rod' || it.type === 'costume');
    const ench = isEquip ? getEntryEnchants(selEntry) : null;
    const plusStr = (ench && ench.count > 0) ? ` (+${ench.count})` : '';
    const maxCount = selEntry.count || 1;
    if (marketSellCount > maxCount) marketSellCount = maxCount;
    if (marketSellCount < 1) marketSellCount = 1;

    const baseVal = it.sellPrice || (it.buyPrice ? Math.floor(it.buyPrice * 0.7) : 50);
    const totalPrice = marketSellCount * marketSellPrice;

    formWrap.innerHTML = `
        <div class="market-sell-form">
            <div class="market-item-preview-card">
                <div id="mkt-preview-icon" style="width:48px; height:48px; position:relative; display:flex; align-items:center; justify-content:center; background:#0f141e; border:1px solid #6c757d; border-radius:8px; flex-shrink:0;">
                </div>
                <div>
                    <div style="font-size: 14px; font-weight: 800; color: ${it.color || '#ffd166'};">${it.name}${plusStr}</div>
                    <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">${it.typeName || ''} • Çantandaki Miktar: <b style="color:#fff;">x${maxCount}</b></div>
                </div>
            </div>

            <!-- Adet Seçimi -->
            <div class="market-field">
                <label>Listelenecek Miktar (Adet)</label>
                ${isEquip ? `
                    <div style="font-size: 12px; color: #ced4da; background: rgba(255,255,255,0.03); padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                        🛡️ 1 Adet (Bu ekipman tekil bir eşyadır)
                    </div>
                ` : `
                    <div class="market-stepper">
                        <button class="market-stepper-btn" id="mkt-cnt-minus">-</button>
                        <input type="number" class="market-input" id="mkt-cnt-input" value="${marketSellCount}" min="1" max="${maxCount}" style="width: 70px; text-align: center;">
                        <button class="market-stepper-btn" id="mkt-cnt-plus">+</button>
                        <button class="action-btn" id="mkt-cnt-all" style="padding: 4px 10px; font-size: 11px;">TÜMÜ (${maxCount})</button>
                    </div>
                `}
            </div>

            <!-- Birim Fiyat Belirleme -->
            <div class="market-field">
                <label>Birim Satış Fiyatı (Altın)</label>
                <div style="display:flex; align-items:center; gap:8px;">
                    <input type="number" class="market-input" id="mkt-price-input" value="${marketSellPrice}" min="1" style="flex:1;">
                    <span style="font-size: 13px; font-weight:700; color: #ffd166;">🪙 Altın</span>
                </div>
                <div class="market-price-pills">
                    <button class="market-pill-btn" data-pr="${baseVal}">Temel: ${baseVal}</button>
                    <button class="market-pill-btn" data-pr="${baseVal * 2}">2x: ${baseVal * 2}</button>
                    <button class="market-pill-btn" data-pr="${baseVal * 5}">5x: ${baseVal * 5}</button>
                    <button class="market-pill-btn" data-pr="${baseVal * 10}">10x: ${baseVal * 10}</button>
                </div>
            </div>

            <!-- Özet Kartı -->
            <div class="market-summary-box">
                <div>
                    <div style="font-size: 11px; color: #94a3b8;">Kazanılacak Tutar</div>
                    <div style="font-size: 12px; color: #e2e8f0;">${marketSellCount} adet x ${marketSellPrice} Altın</div>
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 17px; font-weight: 800; color: #ffd166;" id="mkt-total-preview">🪙 ${totalPrice.toLocaleString('tr-TR')} Altın</span>
                </div>
            </div>

            <button class="action-btn success" id="mkt-submit-btn" style="padding: 10px; font-size: 13px; font-weight: 800; margin-top: 4px;">
                🏷️ Pazarda Listele (İlanı Yayınla)
            </button>
        </div>
    `;

    const previewIconEl = document.getElementById('mkt-preview-icon');
    if (previewIconEl) {
        previewIconEl.appendChild(createItemIconCanvas(it));
    }

    const cntInput = document.getElementById('mkt-cnt-input');
    const priceInput = document.getElementById('mkt-price-input');

    if (cntInput) {
        cntInput.onchange = (e) => {
            let val = parseInt(e.target.value) || 1;
            if (val > maxCount) val = maxCount;
            if (val < 1) val = 1;
            marketSellCount = val;
            renderMarketSellTab(tabContainer, mainContainer);
        };
        const minusBtn = document.getElementById('mkt-cnt-minus');
        if (minusBtn) {
            minusBtn.onclick = () => {
                if (marketSellCount > 1) {
                    marketSellCount--;
                    renderMarketSellTab(tabContainer, mainContainer);
                }
            };
        }
        const plusBtn = document.getElementById('mkt-cnt-plus');
        if (plusBtn) {
            plusBtn.onclick = () => {
                if (marketSellCount < maxCount) {
                    marketSellCount++;
                    renderMarketSellTab(tabContainer, mainContainer);
                }
            };
        }
        const allBtn = document.getElementById('mkt-cnt-all');
        if (allBtn) {
            allBtn.onclick = () => {
                marketSellCount = maxCount;
                renderMarketSellTab(tabContainer, mainContainer);
            };
        }
    }

    if (priceInput) {
        priceInput.oninput = (e) => {
            let val = parseInt(e.target.value) || 1;
            if (val < 1) val = 1;
            marketSellPrice = val;
            const sumEl = document.getElementById('mkt-total-preview');
            if (sumEl) sumEl.textContent = `🪙 ${(marketSellCount * marketSellPrice).toLocaleString('tr-TR')} Altın`;
        };
    }

    document.querySelectorAll('.market-pill-btn').forEach(btn => {
        btn.onclick = () => {
            const p = parseInt(btn.getAttribute('data-pr')) || 100;
            marketSellPrice = p;
            renderMarketSellTab(tabContainer, mainContainer);
        };
    });

    document.getElementById('mkt-submit-btn').onclick = () => {
        if (marketSellPrice < 1) {
            showToast('⚠️ Lütfen geçerli bir birim fiyat girin!', '#ff595e');
            return;
        }

        if (it.type === 'rod' && (player.equipped.rodUid === selEntry.uid || player.equipped.rod === it.id)) {
            player.equipped.rod = null;
            player.equipped.rodUid = null;
            showToast(`[${it.name}] kuşanılmıştı, pazara konulduğu için çıkarıldı.`);
        }
        if (it.type === 'costume' && (player.equipped.costumeUid === selEntry.uid || player.equipped.costume === it.id)) {
            player.equipped.costume = null;
            player.equipped.costumeUid = null;
            showToast(`[${it.name}] kuşanılmıştı, pazara konulduğu için çıkarıldı.`);
        }

        const countToList = isEquip ? 1 : marketSellCount;
        const newListing = {
            id: 'list_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            sellerName: player.name || 'Oyuncu',
            isPlayerListing: true,
            itemId: selEntry.id,
            count: countToList,
            pricePerUnit: marketSellPrice,
            totalPrice: marketSellPrice * countToList,
            createdAt: Date.now(),
            uid: selEntry.uid || null,
            enchants: isEquip ? { ...getEntryEnchants(selEntry) } : null
        };

        if (isEquip && selEntry.uid) {
            removeItemByUid(selEntry.uid);
        } else {
            removeItemFromInventory(selEntry.id, countToList);
        }

        marketListings.unshift(newListing);
        saveMarketData();
        marketSelectedSellIndex = null;
        showToast(`🏷️ [${it.name}${plusStr} x${countToList}] ${newListing.totalPrice} altın fiyatla pazara eklendi!`, '#ffd166');
        addChatMessage('Pazar', `Pazara yeni bir ilan verdin: [${it.name}${plusStr} x${countToList}] (${newListing.totalPrice} Altın)`, 'system');

        marketActiveTab = 'buy';
        renderMarketModal(mainContainer);
    };
}

// 0) TERSANE KAPTANI BARBAROS (Gemi / Tekne Satın Alma & Akdeniz'e Işınlanma NPC'si)
function renderShipyardModal(container) {
    const reqLv = GAME_RULES.akdenizMinLevel || 10;
    const lvOk = player.level >= reqLv;

    container.innerHTML = `
        <div class="npc-panel">
            <div class="npc-panel-header">
                <div>
                    <h3>⛵ Tersane & Akdeniz Seferleri</h3>
                    <div style="font-size:12px; color:#adb5bd; margin-top:3px;">
                        Bir tekneyi 1 kez satın aldığında <b>envanterde yer kaplamaz</b> ve <b>kalıcı olarak senin olur</b>. Satın aldıktan sonra buton <b>"Tekneye Işınlan"</b> butonuna dönüşür!
                    </div>
                </div>
                <div style="display:flex; gap:10px; align-items:center;">
                    <span class="price-tag" style="border-color:${lvOk ? '#80ed99' : '#ff595e'}; color:${lvOk ? '#80ed99' : '#ff595e'};">
                        ${lvOk ? `✅ Giriş Açık (Lv.${player.level}/${reqLv})` : `🔒 Min. Seviye: Lv.${reqLv} (Sen: Lv.${player.level})`}
                    </span>
                    <span class="price-tag">🪙 ${player.gold} Altın</span>
                </div>
            </div>
            <div class="shop-list" id="shipyard-boat-list" style="max-height:420px;"></div>
        </div>
    `;

    const listEl = document.getElementById('shipyard-boat-list');
    Object.values(BOATS).forEach(boat => {
        const isOwned = player.ownedBoats.includes(boat.id);
        const card = document.createElement('div');
        card.className = 'shop-card';
        if (isOwned) {
            card.style.borderColor = 'rgba(76, 201, 240, 0.55)';
            card.style.background = 'rgba(20, 38, 62, 0.85)';
        }

        const left = document.createElement('div');
        left.className = 'shop-card-left';
        left.appendChild(createBoatIconCanvas(boat));

        const isActiveBoat = isOwned && player.activeBoatId === boat.id;
        const infoDiv = document.createElement('div');
        infoDiv.innerHTML = `
            <div class="shop-item-title" style="display:flex; align-items:center; gap:8px;">
                <span>${boat.name}</span>
                <span style="font-size:11px; padding:2px 7px; border-radius:6px; background:rgba(255,209,102,0.15); color:#ffd166; border:1px solid rgba(255,209,102,0.4);">
                    ⚡ Hız: ${boat.speedLabel} (${boat.speed})
                </span>
                ${isOwned ? `<span style="font-size:11px; padding:2px 7px; border-radius:6px; background:rgba(82,183,136,0.2); color:#80ed99;">✔️ Sahipsin</span>` : ''}
                ${isActiveBoat ? `<span style="font-size:11px; padding:2px 7px; border-radius:6px; background:rgba(0,245,212,0.2); color:#00f5d4; border:1px solid #00f5d4; font-weight:700;">★ AKTİF TEKNE</span>` : ''}
            </div>
            <div class="shop-item-desc">${boat.desc}</div>
            ${boat.priceItem && !isOwned ? `
                <div style="margin-top:4px; font-size:12px; color:#ffd166; font-weight:700;">
                    🏴‍☠️ Gereken: ${boat.priceItemCount}x ${ITEMS[boat.priceItem]?.name || 'Eşya'} (Çantandaki: ${getItemCountInInventory(boat.priceItem)} adet)
                </div>
            ` : ''}
        `;
        left.appendChild(infoDiv);

        const right = document.createElement('div');
        right.className = 'shop-card-right';

        if (!isOwned) {
            const buyBtn = document.createElement('button');
            buyBtn.className = 'action-btn primary';
            if (boat.priceItem) {
                const reqItem = ITEMS[boat.priceItem] || { name: 'Özel Eşya' };
                buyBtn.innerHTML = `🏴‍☠️ <b>${boat.priceItemCount}x ${reqItem.name}</b> • Takas Et`;
                buyBtn.style.background = 'linear-gradient(135deg, #1d3557 0%, #0077b6 100%)';
                buyBtn.style.borderColor = '#00f5d4';
                buyBtn.onclick = () => {
                    const currentCount = getItemCountInInventory(boat.priceItem);
                    if (currentCount < boat.priceItemCount) {
                        showToast(`⚠️ ${boat.name} almak için ${boat.priceItemCount} adet [${reqItem.name}] gereklidir! (Mevcut: ${currentCount})`, '#ff595e');
                        return;
                    }
                    removeItemFromInventory(boat.priceItem, boat.priceItemCount);
                    player.ownedBoats.push(boat.id);
                    player.activeBoatId = boat.id;
                    renderBuffBar();
                    renderInventoryUI();
                    showToast(`⛵ TEBRİKLER! Otopilotlu ${boat.name} artık kalıcı olarak senin!`, '#00f5d4');
                    renderShipyardModal(container);
                };
            } else {
                buyBtn.textContent = boat.price === 0 ? 'Ücretsiz Al' : `🪙 ${boat.price} Altın • Satın Al`;
                buyBtn.onclick = () => {
                    if (player.gold < boat.price) {
                        showToast(`⚠️ ${boat.name} almak için yeterli altının yok! (${boat.price} 🪙 gerekli)`, '#ff595e');
                        return;
                    }
                    player.gold -= boat.price;
                    player.ownedBoats.push(boat.id);
                    player.activeBoatId = boat.id;
                    updateGoldHUD();
                    renderBuffBar();
                    showToast(`⛵ Tebrikler! ${boat.name} artık kalıcı olarak senin! Şimdi "Tekneye Işınlan" butonuyla Akdeniz'e açılabilirsin.`, '#80ed99');
                    renderShipyardModal(container);
                };
            }
            right.appendChild(buyBtn);
        } else {
            const tpBtn = document.createElement('button');
            tpBtn.className = 'action-btn success';
            tpBtn.style.padding = '9px 16px';
            tpBtn.innerHTML = isActiveBoat ? `🌊 Tekneye Işınlan (${boat.name})` : `🚢 Bu Tekneyi Seç & Işınlan`;
            tpBtn.onclick = () => {
                const minLv = GAME_RULES.akdenizMinLevel || 10;
                if (player.level < minLv) {
                    showToast(`⚠️ Akdeniz haritasına giriş için minimum Lv. ${minLv} olmalısın! (Mevcut Seviyen: Lv. ${player.level})`, '#ff595e');
                    return;
                }
                player.activeBoatId = boat.id;
                currentMapId = 'akdeniz';
                player.x = 13.5;
                player.y = 17.5;
                player.path = [];
                player.targetMarker = null;
                document.getElementById('npc-modal').classList.add('hidden');
                showToast(`⛵ ${boat.name} ile Akdeniz sularına ışınlandın! Sarı Bereket Bölgesinde 1.5x değerli balık şansı seni bekliyor!`, '#4cc9f0');
            };
            right.appendChild(tpBtn);
        }

        card.appendChild(left);
        card.appendChild(right);
        listEl.appendChild(card);
    });
}

// 1) DEPOCU (2 Sayfa x 24 Slot Kasa)
function renderStorageModal(container) {
    sanitizeVaultAndInventoryCostumes();
    const pageIdx = player.activeStoragePage;
    const vaultPage = player.storage[pageIdx];

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>Kasa (Sayfa ${pageIdx + 1} / 2 - 24 Slot)</h3>
                    <div class="tab-group">
                        <button class="tab-btn ${pageIdx === 0 ? 'active' : ''}" id="st-page-0">1. Sayfa</button>
                        <button class="tab-btn ${pageIdx === 1 ? 'active' : ''}" id="st-page-1">2. Sayfa</button>
                    </div>
                </div>
                <div class="slot-grid" id="storage-vault-grid"></div>
                <div class="bag-subhint">Kasadan çantana almak istediğin eşyaya tıkla.</div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>Çantan (${player.inventory.length} / 24)</h3>
                </div>
                <div class="slot-grid" id="storage-bag-grid"></div>
                <div class="bag-subhint">Kasaya yatırmak istediğin eşyaya tıkla.</div>
            </div>
        </div>
    `;

    document.getElementById('st-page-0').onclick = () => { player.activeStoragePage = 0; renderStorageModal(container); };
    document.getElementById('st-page-1').onclick = () => { player.activeStoragePage = 1; renderStorageModal(container); };

    const vaultGrid = document.getElementById('storage-vault-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';
        const entry = vaultPage[i];
        if (entry && ITEMS[entry.id]) {
            const item = ITEMS[entry.id];
            const wrap = document.createElement('div');
            wrap.className = 'slot-item-icon';
            wrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(wrap);
            if (entry.count > 1) {
                const c = document.createElement('span');
                c.className = 'item-count';
                c.textContent = `x${entry.count}`;
                slotDiv.appendChild(c);
            }
            if ((item.type === 'rod' || item.type === 'costume') && entry.enchants && entry.enchants.count > 0) {
                const eb = document.createElement('span');
                eb.className = 'enchant-badge';
                eb.textContent = `+${entry.enchants.count}`;
                slotDiv.appendChild(eb);
            }
            if (item.isRoyal || item.isSOS) {
                slotDiv.classList.add('sos-slot');
            }
            const e = (item.type === 'rod' || item.type === 'costume') ? (entry.enchants || getEntryEnchants(entry)) : null;
            const plusStr = e && e.count > 0 ? ` (+${e.count})` : '';
            slotDiv.title = `${item.name}${plusStr} (Çantaya çekmek için tıkla)`;
            slotDiv.onclick = () => {
                if (addItemToInventory(entry.id, entry.count, entry.enchants || null)) {
                    vaultPage[i] = null;
                    renderStorageModal(container);
                } else {
                    showToast('⚠️ Çantan dolu!', '#ff595e');
                }
            };
        }
        vaultGrid.appendChild(slotDiv);
    }

    const bagGrid = document.getElementById('storage-bag-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';
        const entry = player.inventory[i];
        if (entry && ITEMS[entry.id]) {
            const item = ITEMS[entry.id];
            const wrap = document.createElement('div');
            wrap.className = 'slot-item-icon';
            wrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(wrap);
            if (entry.count > 1) {
                const c = document.createElement('span');
                c.className = 'item-count';
                c.textContent = `x${entry.count}`;
                slotDiv.appendChild(c);
            }
            if (item.type === 'rod' || item.type === 'costume') {
                const e = getEntryEnchants(entry);
                if (e && e.count > 0) {
                    const eb = document.createElement('span');
                    eb.className = 'enchant-badge';
                    eb.textContent = `+${e.count}`;
                    slotDiv.appendChild(eb);
                }
            }
            if (item.isRoyal || item.isSOS) {
                slotDiv.classList.add('sos-slot');
            }
            const e = (item.type === 'rod' || item.type === 'costume') ? getEntryEnchants(entry) : null;
            const plusStr = e && e.count > 0 ? ` (+${e.count})` : '';
            slotDiv.title = `${item.name}${plusStr} (Kasaya koymak için tıkla)`;
            slotDiv.onclick = () => {
                if (item.type === 'rod' || item.type === 'costume') {
                    const emptySlot = vaultPage.findIndex(s => s === null);
                    if (emptySlot === -1) {
                        showToast('⚠️ Kasanın bu sayfası dolu! Diğer sayfaya geçebilirsin.', '#ff595e');
                        return;
                    }
                    vaultPage[emptySlot] = {
                        id: entry.id,
                        count: 1,
                        uid: entry.uid || generateItemUid(),
                        enchants: { ...getEntryEnchants(entry) }
                    };
                    if (entry.uid) {
                        removeItemByUid(entry.uid);
                    } else {
                        removeItemFromInventory(entry.id, 1);
                    }
                } else {
                    let targetSlot = vaultPage.findIndex(s => s && s.id === entry.id);
                    if (targetSlot !== -1) {
                        vaultPage[targetSlot].count += 1;
                    } else {
                        targetSlot = vaultPage.findIndex(s => s === null);
                        if (targetSlot === -1) {
                            showToast('⚠️ Kasanın bu sayfası dolu! Diğer sayfaya geçebilirsin.', '#ff595e');
                            return;
                        }
                        vaultPage[targetSlot] = { id: entry.id, count: 1 };
                    }
                    removeItemFromInventory(entry.id, 1);
                }
                renderStorageModal(container);
            };
        }
        bagGrid.appendChild(slotDiv);
    }
}

// 2) BALIKÇI REİS (Görsel İkon Fix + Çoklu Alım Slide Bar + Buyback Geri Al Sekmesi)
function renderFishermanModal(container) {
    const shopItems = Object.values(ITEMS).filter(it =>
        (it.type === 'rod' || it.type === 'bait') && it.id !== 'rod_dragon' && it.id !== 'rod_burak' && it.buyPrice !== undefined
    );

    const sellableEntries = player.inventory.filter(e => {
        const it = ITEMS[e.id];
        return it && (it.type === 'fish' || it.type === 'rod' || it.type === 'bait');
    });

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>Olta & Yem Dükkânı (Çoklu Alım)</h3>
                    <span class="price-tag">🪙 ${player.gold} Altın</span>
                </div>
                <div class="shop-list" id="fisherman-buy-list"></div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <div class="tab-group">
                        <button class="tab-btn ${fishermanRightTab === 'sell' ? 'active' : ''}" id="fish-tab-sell">💰 Eşya Sat (${sellableEntries.length})</button>
                        <button class="tab-btn ${fishermanRightTab === 'buyback' ? 'active' : ''}" id="fish-tab-buyback">↩️ Geri Al (${player.buybackList.length})</button>
                    </div>
                    ${fishermanRightTab === 'sell' ? `<button class="action-btn success" id="sell-all-fish-btn">Tüm Balıkları Sat</button>` : ''}
                </div>
                <div class="shop-list" id="fisherman-right-list"></div>
            </div>
        </div>
    `;

    document.getElementById('fish-tab-sell').onclick = () => {
        fishermanRightTab = 'sell';
        renderFishermanModal(container);
    };
    document.getElementById('fish-tab-buyback').onclick = () => {
        fishermanRightTab = 'buyback';
        renderFishermanModal(container);
    };

    const buyList = document.getElementById('fisherman-buy-list');
    shopItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'shop-card';

        const left = document.createElement('div');
        left.className = 'shop-card-left';
        left.appendChild(createItemIconCanvas(item));

        const infoDiv = document.createElement('div');
        infoDiv.innerHTML = `
            <div class="shop-item-title">${item.name}</div>
            <div class="shop-item-desc">${item.desc}</div>
            <div style="font-size:11px; color:#ffd166; margin-top:2px;">Birim Fiyat: 🪙 ${item.buyPrice} Altın</div>
        `;
        left.appendChild(infoDiv);

        const right = document.createElement('div');
        right.className = 'shop-card-right';

        const maxQty = item.type === 'rod' ? Math.max(1, 24 - player.inventory.length) : 50;

        const sliderWrap = document.createElement('div');
        sliderWrap.className = 'qty-slider-wrap';

        const rangeInput = document.createElement('input');
        rangeInput.type = 'range';
        rangeInput.className = 'qty-range';
        rangeInput.min = '1';
        rangeInput.max = String(maxQty);
        rangeInput.value = '1';

        const qtyBadge = document.createElement('span');
        qtyBadge.className = 'qty-val-badge';
        qtyBadge.textContent = 'x1';

        sliderWrap.appendChild(rangeInput);
        sliderWrap.appendChild(qtyBadge);

        const btn = document.createElement('button');
        btn.className = 'action-btn primary';
        const updateBtnLabel = () => {
            const q = parseInt(rangeInput.value, 10) || 1;
            const totalCost = item.buyPrice * q;
            qtyBadge.textContent = `x${q}`;
            btn.textContent = totalCost === 0
                ? `Ücretsiz Al (${q} Adet)`
                : `🪙 ${totalCost} Satın Al (${q}x)`;
        };
        updateBtnLabel();
        rangeInput.oninput = updateBtnLabel;

        btn.onclick = () => {
            const q = parseInt(rangeInput.value, 10) || 1;
            const totalCost = item.buyPrice * q;
            if (player.gold < totalCost) {
                showToast(`⚠️ Yeterli altının yok! (${totalCost} Altın gerekli)`, '#ff595e');
                return;
            }
            const added = addItemToInventory(item.id, q);
            if (!added) {
                showToast('⚠️ Çantanda yeterli boş slot yok!', '#ff595e');
                return;
            }
            player.gold -= totalCost;
            if (!player.equipped.rod && item.type === 'rod') {
                player.equipped.rod = item.id;
                if (typeof added === 'string') player.equipped.rodUid = added;
            }
            updateGoldHUD();
renderBuffBar();
            showToast(`🛒 ${q}x ${item.name} satın aldın!`, '#52b788');
            renderFishermanModal(container);
        };

        right.appendChild(sliderWrap);
        right.appendChild(btn);
        card.appendChild(left);
        card.appendChild(right);
        buyList.appendChild(card);
    });

    const rightList = document.getElementById('fisherman-right-list');

    if (fishermanRightTab === 'sell') {
        if (sellableEntries.length === 0) {
            rightList.innerHTML = `<div class="empty-notice">Çantanda satılacak balık, olta veya yem bulunmuyor.</div>`;
        } else {
            sellableEntries.forEach(entry => {
                const item = ITEMS[entry.id];
                const sPrice = item.sellPrice ?? 0;
                const ench = item.type === 'rod' ? getEntryEnchants(entry) : null;
                const plusStr = ench && ench.count > 0 ? ` (+${ench.count})` : '';

                const card = document.createElement('div');
                card.className = 'shop-card';

                const left = document.createElement('div');
                left.className = 'shop-card-left';
                left.appendChild(createItemIconCanvas(item));

                const infoDiv = document.createElement('div');
                infoDiv.innerHTML = `
                    <div class="shop-item-title">${item.name}${plusStr} ${entry.count > 1 ? `(x${entry.count})` : ''}</div>
                    <div class="shop-item-desc">${item.typeName} • Birim Satış: 🪙 ${sPrice}</div>
                `;
                left.appendChild(infoDiv);

                const right = document.createElement('div');
                right.className = 'shop-card-right';

                let sellQty = 1;
                if (entry.count > 1) {
                    const sliderWrap = document.createElement('div');
                    sliderWrap.className = 'qty-slider-wrap';
                    const rangeInput = document.createElement('input');
                    rangeInput.type = 'range';
                    rangeInput.className = 'qty-range';
                    rangeInput.min = '1';
                    rangeInput.max = String(entry.count);
                    rangeInput.value = '1';
                    const qtyBadge = document.createElement('span');
                    qtyBadge.className = 'qty-val-badge';
                    qtyBadge.textContent = 'x1';
                    sliderWrap.appendChild(rangeInput);
                    sliderWrap.appendChild(qtyBadge);
                    right.appendChild(sliderWrap);

                    const btn = document.createElement('button');
                    btn.className = 'action-btn success';
                    const syncSellBtn = () => {
                        sellQty = parseInt(rangeInput.value, 10) || 1;
                        qtyBadge.textContent = `x${sellQty}`;
                        btn.textContent = `Sat (+${sPrice * sellQty} 🪙)`;
                    };
                    syncSellBtn();
                    rangeInput.oninput = syncSellBtn;

                    btn.onclick = () => {
                        pushToBuyback(item.id, sellQty, sPrice, null);
                        removeItemFromInventory(item.id, sellQty);
                        player.gold += sPrice * sellQty;
                        updateGoldHUD();
renderBuffBar();
                        showToast(`🪙 ${sellQty}x ${item.name} sattın (+${sPrice * sellQty} Altın). "Geri Al" sekmesinden geri alabilirsin.`, '#ffd166');
                        renderFishermanModal(container);
                    };
                    right.appendChild(btn);
                } else {
                    const btn = document.createElement('button');
                    btn.className = 'action-btn success';
                    btn.textContent = `Sat (+${sPrice} 🪙)`;
                    btn.onclick = () => {
                        const savedEnch = item.type === 'rod' ? { ...getEntryEnchants(entry) } : null;
                        pushToBuyback(item.id, 1, sPrice, savedEnch);
                        if (entry.uid && item.type === 'rod') {
                            removeItemByUid(entry.uid);
                        } else {
                            removeItemFromInventory(item.id, 1);
                        }
                        player.gold += sPrice;
                        updateGoldHUD();
renderBuffBar();
                        showToast(`🪙 ${item.name}${plusStr} sattın (+${sPrice} Altın). Yanlışlıkla sattıysan "Geri Al" sekmesinden alabilirsin!`, '#ffd166');
                        renderFishermanModal(container);
                    };
                    right.appendChild(btn);
                }

                card.appendChild(left);
                card.appendChild(right);
                rightList.appendChild(card);
            });
        }

        const sellAllBtn = document.getElementById('sell-all-fish-btn');
        if (sellAllBtn) {
            sellAllBtn.onclick = () => {
                const onlyFishes = player.inventory.filter(e => ITEMS[e.id]?.type === 'fish');
                if (onlyFishes.length === 0) return;
                let totalEarned = 0;
                [...onlyFishes].forEach(entry => {
                    const fish = ITEMS[entry.id];
                    const uPrice = fish.sellPrice ?? 0;
                    totalEarned += uPrice * entry.count;
                    pushToBuyback(fish.id, entry.count, uPrice, null);
                    removeItemFromInventory(fish.id, entry.count);
                });
                player.gold += totalEarned;
                updateGoldHUD();
renderBuffBar();
                showToast(`🪙 Tüm balıkları sattın! Toplam +${totalEarned} Altın. ("Geri Al" listesine eklendi)`, '#ffd166');
                renderFishermanModal(container);
            };
        }
    } else {
        // BUYBACK (GERİ AL) SEKMESİ
        renderBuybackListUI(rightList, () => renderFishermanModal(container));
    }
}

// Ortak Buyback (Geri Al) Listesi Render Fonksiyonu
function renderBuybackListUI(listContainer, onRefresh) {
    if (player.buybackList.length === 0) {
        listContainer.innerHTML = `<div class="empty-notice">Henüz sattığın bir eşya yok.<br>Yanlışlıkla sattığın balık, olta veya eşyalar burada görünür ve sattığın fiyata geri alabilirsin.</div>`;
        return;
    }

    player.buybackList.forEach((bb, idx) => {
        const item = ITEMS[bb.id];
        if (!item) return;
        const plusStr = bb.enchants && bb.enchants.count > 0 ? ` (+${bb.enchants.count})` : '';

        const card = document.createElement('div');
        card.className = 'shop-card';

        const left = document.createElement('div');
        left.className = 'shop-card-left';
        left.appendChild(createItemIconCanvas(item));

        const infoDiv = document.createElement('div');
        infoDiv.innerHTML = `
            <div class="shop-item-title">${item.name}${plusStr} ${bb.count > 1 ? `(x${bb.count})` : ''}</div>
            <div class="shop-item-desc">Geri Alma Bedeli: 🪙 ${bb.totalPrice} Altın</div>
        `;
        left.appendChild(infoDiv);

        const btn = document.createElement('button');
        btn.className = 'action-btn primary';
        btn.textContent = `↩️ Geri Al (🪙 ${bb.totalPrice})`;
        btn.onclick = () => {
            if (player.gold < bb.totalPrice) {
                showToast('⚠️ Geri almak için yeterli altının yok!', '#ff595e');
                return;
            }
            if (!addItemToInventory(bb.id, bb.count, bb.enchants)) {
                showToast('⚠️ Çantan dolu!', '#ff595e');
                return;
            }
            player.gold -= bb.totalPrice;
            player.buybackList.splice(idx, 1);
            updateGoldHUD();
renderBuffBar();
            showToast(`↩️ ${bb.count}x ${item.name}${plusStr} envanterine geri alındı!`, '#4cc9f0');
            onRefresh();
        };

        card.appendChild(left);
        card.appendChild(btn);
        listContainer.appendChild(card);
    });
}

// 3) SİMYACI (Görsel İkon Fix + Çoklu Alım Slide Bar + Satış / Buyback)
function renderAlchemistModal(container) {
    const scrolls = Object.values(ITEMS).filter(i => i.type === 'scroll');
    const playerScrolls = player.inventory.filter(e => ITEMS[e.id]?.type === 'scroll');

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>Efsun Kağıdı Dükkânı (Çoklu Alım)</h3>
                    <span class="price-tag">🪙 ${player.gold} Altın</span>
                </div>
                <div class="shop-list" id="alchemist-list"></div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <div class="tab-group">
                        <button class="tab-btn ${alchemistRightTab === 'bag' ? 'active' : ''}" id="alc-tab-bag">📜 Çantadaki Kağıtlar (${playerScrolls.length})</button>
                        <button class="tab-btn ${alchemistRightTab === 'buyback' ? 'active' : ''}" id="alc-tab-buyback">↩️ Geri Al (${player.buybackList.length})</button>
                    </div>
                </div>
                <div class="shop-list" id="alchemist-right-list"></div>
            </div>
        </div>
    `;

    document.getElementById('alc-tab-bag').onclick = () => {
        alchemistRightTab = 'bag';
        renderAlchemistModal(container);
    };
    document.getElementById('alc-tab-buyback').onclick = () => {
        alchemistRightTab = 'buyback';
        renderAlchemistModal(container);
    };

    const list = document.getElementById('alchemist-list');
    scrolls.forEach(sc => {
        const card = document.createElement('div');
        card.className = 'shop-card';

        const left = document.createElement('div');
        left.className = 'shop-card-left';
        left.appendChild(createItemIconCanvas(sc));

        const infoDiv = document.createElement('div');
        infoDiv.innerHTML = `
            <div class="shop-item-title">${sc.name}</div>
            <div class="shop-item-desc">${sc.desc}</div>
            <div style="font-size:11px; color:#ffd166; margin-top:2px;">Birim Fiyat: 🪙 ${sc.buyPrice} Altın</div>
        `;
        left.appendChild(infoDiv);

        const right = document.createElement('div');
        right.className = 'shop-card-right';

        const sliderWrap = document.createElement('div');
        sliderWrap.className = 'qty-slider-wrap';

        const rangeInput = document.createElement('input');
        rangeInput.type = 'range';
        rangeInput.className = 'qty-range';
        rangeInput.min = '1';
        rangeInput.max = '30';
        rangeInput.value = '1';

        const qtyBadge = document.createElement('span');
        qtyBadge.className = 'qty-val-badge';
        qtyBadge.textContent = 'x1';

        sliderWrap.appendChild(rangeInput);
        sliderWrap.appendChild(qtyBadge);

        const btn = document.createElement('button');
        btn.className = 'action-btn primary';
        const updateBtn = () => {
            const q = parseInt(rangeInput.value, 10) || 1;
            const total = sc.buyPrice * q;
            qtyBadge.textContent = `x${q}`;
            btn.textContent = `🪙 ${total} Satın Al (${q}x)`;
        };
        updateBtn();
        rangeInput.oninput = updateBtn;

        btn.onclick = () => {
            const q = parseInt(rangeInput.value, 10) || 1;
            const total = sc.buyPrice * q;
            if (player.gold < total) {
                showToast(`⚠️ Yeterli altının yok! (${total} Altın gerekli)`, '#ff595e');
                return;
            }
            if (!addItemToInventory(sc.id, q)) {
                showToast('⚠️ Çantan dolu!', '#ff595e');
                return;
            }
            player.gold -= total;
            updateGoldHUD();
renderBuffBar();
            showToast(`✨ ${q}x ${sc.name} satın aldın! Efsunlu Örs'te oltana basabilirsin.`, '#c77dff');
            renderAlchemistModal(container);
        };

        right.appendChild(sliderWrap);
        right.appendChild(btn);
        card.appendChild(left);
        card.appendChild(right);
        list.appendChild(card);
    });

    const rightList = document.getElementById('alchemist-right-list');
    if (alchemistRightTab === 'bag') {
        if (playerScrolls.length === 0) {
            rightList.innerHTML = `<div class="empty-notice">Çantanda efsun kağıdı bulunmuyor. Soldaki dükkândan miktar seçerek alabilirsin.</div>`;
        } else {
            playerScrolls.forEach(entry => {
                const sc = ITEMS[entry.id];
                const sellVal = sc.sellPrice ?? Math.floor((sc.buyPrice || 100) * 0.5);
                const card = document.createElement('div');
                card.className = 'shop-card';
                const left = document.createElement('div');
                left.className = 'shop-card-left';
                left.appendChild(createItemIconCanvas(sc));
                const infoDiv = document.createElement('div');
                infoDiv.innerHTML = `
                    <div class="shop-item-title">${sc.name} (x${entry.count})</div>
                    <div class="shop-item-desc">Satış Fiyatı: 🪙 ${sellVal} Altın</div>
                `;
                left.appendChild(infoDiv);

                const btn = document.createElement('button');
                btn.className = 'action-btn success';
                btn.textContent = `Sat (+${sellVal} 🪙)`;
                btn.onclick = () => {
                    pushToBuyback(sc.id, 1, sellVal, null);
                    removeItemFromInventory(sc.id, 1);
                    player.gold += sellVal;
                    updateGoldHUD();
renderBuffBar();
                    showToast(`🪙 ${sc.name} sattın (+${sellVal} Altın)`, '#ffd166');
                    renderAlchemistModal(container);
                };

                card.appendChild(left);
                card.appendChild(btn);
                rightList.appendChild(card);
            });
        }
    } else {
        renderBuybackListUI(rightList, () => renderAlchemistModal(container));
    }
}

// 4) MARANGOZ (Olta Craft Atölyesi - Balıkçı Burak'ın Efsunlu Oltası SOS)
function renderCarpenterModal(container) {
    const reqPearls = Number(GAME_RULES.craftBurakPearls ?? 5);
    const reqTreasures = Number(GAME_RULES.craftBurakTreasures ?? 2);
    const pearlEntry = player.inventory.find(i => i.id === 'item_pearl');
    const pearlCount = pearlEntry ? pearlEntry.count : 0;
    const treasureEntry = player.inventory.find(i => i.id === 'item_dead_sailor_treasure');
    const treasureCount = treasureEntry ? treasureEntry.count : 0;
    const canCraft = pearlCount >= reqPearls && treasureCount >= reqTreasures;
    const burakRod = ITEMS.rod_burak;

    container.innerHTML = `
        <div class="carpenter-workbench">
            <div style="background: rgba(0,0,0,0.32); border-radius:10px; padding:12px 16px; border:1px solid rgba(255,209,102,0.3); display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <h3 style="color:#ffd166; font-size:17px; margin-bottom:4px;">🪵 Marangoz Çınar'ın Olta Craft Tezgâhı</h3>
                    <p style="color:#adb5bd; font-size:12.5px; margin:0;">Kadim deniz hazineleriyle efsanevi Silkroad SOS oltalarını burada dövebilirsin.</p>
                </div>
                <div style="text-align:right;">
                    <span class="price-tag">🪙 ${player.gold} Altın</span>
                </div>
            </div>

            <div class="craft-card">
                <div class="craft-preview-box" id="carpenter-rod-preview">
                    <span class="sos-badge">SOS</span>
                </div>
                <div class="craft-details">
                    <div class="craft-title-row">
                        <span class="craft-title">${burakRod.name}</span>
                        <span style="background:rgba(0,245,212,0.18); border:1px solid #00f5d4; color:#00f5d4; font-size:11px; padding:2px 6px; border-radius:4px; font-weight:700;">SEAL OF STAR</span>
                    </div>
                    <p style="color:#ced4da; font-size:12.5px; margin:2px 0 6px;">
                        ${burakRod.desc}
                    </p>
                    <div class="craft-stats-pills">
                        <span class="craft-stat-pill pill-speed">⚡ Balık Vurma: -%${burakRod.speedBonus} Süre</span>
                        <span class="craft-stat-pill pill-luck">🍀 Nadir/Efsanevi: +%${burakRod.luckBonus} Şans</span>
                        <span class="craft-stat-pill pill-auto">🤖 Auto-Hunt: +%${burakRod.autoHuntSpeedBonus} Hızlı</span>
                    </div>

                    <div class="craft-materials-req">
                        <div class="mat-item-req ${pearlCount >= reqPearls ? 'ok' : 'missing'}" id="mat-pearl-box">
                            <span style="font-size:18px;">🦪</span>
                            <span>İnci: <b>${pearlCount} / ${reqPearls}</b> ${pearlCount >= reqPearls ? '✓' : '✗'}</span>
                        </div>
                        <div class="mat-item-req ${treasureCount >= reqTreasures ? 'ok' : 'missing'}" id="mat-treasure-box">
                            <span style="font-size:18px;">🏴‍☠️</span>
                            <span>Ölü Denizcinin Hazinesi: <b>${treasureCount} / ${reqTreasures}</b> ${treasureCount >= reqTreasures ? '✓' : '✗'}</span>
                        </div>
                    </div>
                </div>

                <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
                    <button class="btn-craft-rod" id="btn-craft-burak-rod" ${canCraft ? '' : 'disabled'}>
                        🔨 Oltayı Üret (Craft)
                    </button>
                    ${!canCraft ? '<span style="font-size:11px; color:#ff595e; text-align:center;">Gerekli malzemeler eksik</span>' : '<span style="font-size:11px; color:#80ed99; text-align:center;">Tüm malzemeler hazır!</span>'}
                </div>
            </div>

            <div style="background: rgba(13,27,42,0.7); border:1px dashed rgba(76,201,240,0.35); border-radius:10px; padding:12px 16px; font-size:12.5px; color:#ced4da;">
                <b style="color:#4cc9f0;">💡 Craft Malzemeleri Nereden Bulunur?</b>
                <div style="margin-top:4px; display:flex; flex-direction:column; gap:3px;">
                    <span>• <b>İnci:</b> Akdeniz ve kıyı sularında balık tutarken nadiren oltaya takılır veya Bahisçi Bülo'dan çıkar.</span>
                    <span>• <b>Ölü Denizcinin Hazinesi:</b> Açık deniz ve okyanus sularında balık avlarken çıkar.</span>
                    <span style="color:#ffd166;">• <i>İpucu:</i> Akdeniz'deki Sarı Bereket Bölgesi'nde avlanmak değerli ganimet şansını 1.5 katına çıkarır!</span>
                </div>
            </div>
        </div>
    `;

    const prevHolder = document.getElementById('carpenter-rod-preview');
    if (prevHolder) {
        prevHolder.appendChild(createItemIconCanvas(burakRod));
    }

    const craftBtn = document.getElementById('btn-craft-burak-rod');
    if (craftBtn && canCraft) {
        craftBtn.addEventListener('click', () => {
            if (player.inventory.length >= 24) {
                showToast('⚠️ Çantanda hiç boş yer kalmamış! Önce bir eşya satmalı veya depoya koymalısın.', '#ff595e');
                return;
            }

            const currentPearls = player.inventory.find(i => i.id === 'item_pearl')?.count || 0;
            const currentTreasures = player.inventory.find(i => i.id === 'item_dead_sailor_treasure')?.count || 0;

            if (currentPearls < reqPearls || currentTreasures < reqTreasures) {
                showToast(`⚠️ Yetersiz malzeme! ${reqPearls} İnci ve ${reqTreasures} Ölü Denizcinin Hazinesi gereklidir.`, '#ff595e');
                return;
            }

            const carpWisdomLv = player.skills.carpenter_wisdom || 0;
            const savedMaterials = carpWisdomLv > 0 && (Math.random() * 100) < carpWisdomLv;

            if (savedMaterials) {
                showToast(`🪚 [Marangoz'un Bilgeliği] (%${carpWisdomLv}) Kadim zanaat bilgeliğin sayesinde craft malzemelerin harcanmadı!`, '#ffd166');
            } else {
                removeItemFromInventory('item_pearl', reqPearls);
                removeItemFromInventory('item_dead_sailor_treasure', reqTreasures);
            }

            addItemToInventory('rod_burak', 1);

            showToast("🌟 TEBRİKLER! Balıkçı Burak'ın Efsunlu Oltası (SOS) başarıyla üretildi!", '#ffd166');
            renderCarpenterModal(container);
            renderInventoryUI();
        });
    }
}

// 5) ŞEF (Balık Pişirme & 10 Dk Buff - İkon Fix)
function renderChefModal(container) {
    const rawFishes = player.inventory.filter(e => ITEMS[e.id]?.type === 'fish');
    const cookedFishes = player.inventory.filter(e => ITEMS[e.id]?.type === 'cooked_fish');

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>Çiğ Balıkları Pişir</h3>
                </div>
                <div class="shop-list" id="chef-raw-list"></div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>Pişmiş Balıkların (10 Dk Buff)</h3>
                </div>
                <div class="shop-list" id="chef-cooked-list"></div>
            </div>
        </div>
    `;

    const rawList = document.getElementById('chef-raw-list');
    if (rawFishes.length === 0) {
        rawList.innerHTML = `<div class="empty-notice">Çantanda pişirilecek çiğ balık yok.</div>`;
    } else {
        rawFishes.forEach(entry => {
            const fish = ITEMS[entry.id];
            const cooked = ITEMS[`cooked_${fish.id}`];
            const card = document.createElement('div');
            card.className = 'shop-card';
            const left = document.createElement('div');
            left.className = 'shop-card-left';
            left.appendChild(createItemIconCanvas(fish));

            const infoDiv = document.createElement('div');
            infoDiv.innerHTML = `
                <div class="shop-item-title">${fish.name} (x${entry.count})</div>
                <div class="shop-item-desc">Buff: ${fish.rarity.buffDesc}</div>
            `;
            left.appendChild(infoDiv);

            const btnGroup = document.createElement('div');
            btnGroup.style.display = 'flex';
            btnGroup.style.gap = '6px';

            const cookBtn = document.createElement('button');
            cookBtn.className = 'action-btn primary';
            cookBtn.textContent = '🔥 Pişir';
            cookBtn.onclick = () => {
                removeItemFromInventory(fish.id, 1);
                addItemToInventory(cooked.id, 1);
                showToast(`🍳 ${cooked.name} hazırlandı!`, '#ff9f1c');
                renderChefModal(container);
            };

            const eatNowBtn = document.createElement('button');
            eatNowBtn.className = 'action-btn success';
            eatNowBtn.textContent = '🍽️ Pişir & Ye';
            eatNowBtn.onclick = () => {
                removeItemFromInventory(fish.id, 1);
                activateCookedFishBuff(cooked);
                renderChefModal(container);
            };

            btnGroup.appendChild(cookBtn);
            btnGroup.appendChild(eatNowBtn);
            card.appendChild(left);
            card.appendChild(btnGroup);
            rawList.appendChild(card);
        });
    }

    const cookedList = document.getElementById('chef-cooked-list');
    if (cookedFishes.length === 0) {
        cookedList.innerHTML = `<div class="empty-notice">Henüz pişmiş balığın yok.<br>Pişirdiğin balıkları buradan veya envanterinden (I) yiyebilirsin.</div>`;
    } else {
        cookedFishes.forEach(entry => {
            const cItem = ITEMS[entry.id];
            const card = document.createElement('div');
            card.className = 'shop-card';
            const left = document.createElement('div');
            left.className = 'shop-card-left';
            left.appendChild(createItemIconCanvas(cItem));

            const infoDiv = document.createElement('div');
            infoDiv.innerHTML = `
                <div class="shop-item-title">${cItem.name} (x${entry.count})</div>
                <div class="shop-item-desc">${cItem.rarity.buffDesc}</div>
            `;
            left.appendChild(infoDiv);

            const eatBtn = document.createElement('button');
            eatBtn.className = 'action-btn success';
            eatBtn.textContent = '🍖 Şimdi Ye';
            eatBtn.onclick = () => {
                removeItemFromInventory(cItem.id, 1);
                activateCookedFishBuff(cItem);
                renderChefModal(container);
            };
            card.appendChild(left);
            card.appendChild(eatBtn);
            cookedList.appendChild(card);
        });
    }
}

// 6) ANVIL (Efsunlu Örs - Artı Basma, Efsun Kağıdı ve Opsiyonel Koruma Parşömeni Slotu)
function renderAnvilModal(container) {
    // Seçili olta veya kostüm, efsun kağıdı ve koruma parşömeninin hâlâ envanterde olup olmadığını doğrula
    const activeItemUid = anvilState.itemUid || anvilState.rodUid;
    const selectedItemEntry = activeItemUid
        ? player.inventory.find(i => i.uid === activeItemUid)
        : null;
    if (!selectedItemEntry) {
        anvilState.itemUid = null;
        anvilState.rodUid = null;
    }

    const selectedScrollEntry = anvilState.scrollId
        ? player.inventory.find(i => i.id === anvilState.scrollId && ITEMS[i.id]?.type === 'scroll')
        : null;
    if (!selectedScrollEntry) anvilState.scrollId = null;

    const selectedProtectEntry = anvilState.protectScrollId
        ? player.inventory.find(i => i.id === anvilState.protectScrollId && (i.id === 'scroll_protection' || ITEMS[i.id]?.type === 'protect_scroll'))
        : null;
    if (!selectedProtectEntry) anvilState.protectScrollId = null;

    const targetItem = selectedItemEntry ? ITEMS[selectedItemEntry.id] : null;
    const scrollItem = selectedScrollEntry ? ITEMS[selectedScrollEntry.id] : null;
    const protectItem = selectedProtectEntry ? ITEMS[selectedProtectEntry.id] : null;

    const ench = selectedItemEntry ? getEntryEnchants(selectedItemEntry) : null;
    const currentStep = ench ? ench.count : 0;
    const baseChance = currentStep < MAX_ENCHANT_COUNT ? (ENCHANT_SUCCESS_RATES[currentStep] ?? 5) : 0;
    const anvilPatronLv = player.skills.anvil_patron || 0; // Seviye başına +%1
    const guildAlchemistLv = getGuildSkillLevel('guild_alchemist');
    const guildAlchemistBonus = guildAlchemistLv * 0.5; // Lonca Simyacısı: Seviye başına +%0.5
    const costumeAnvilBonus = getEquippedCostumeItem()?.anvilBonus || 0; // Kraliyet Muhafızı: +%5 Anvil Şansı
    const nextChance = Math.min(100, baseChance + anvilPatronLv + guildAlchemistBonus + costumeAnvilBonus);

    const slotLabelText = targetItem
        ? (targetItem.type === 'costume' ? '1. KOSTÜM SLOTU' : '1. OLTA SLOTU')
        : '1. OLTA / KOSTÜM';

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🔨 Efsunlu Örs Tezgâhı</h3>
                    <span style="font-size:11.5px; color:#adb5bd;">Sağdaki envanterden Olta veya Kostümünü seç</span>
                </div>
                <div class="anvil-stage" id="anvil-workbench">
                    <div class="anvil-slots-container">
                        <div class="anvil-slot-box ${targetItem ? (targetItem.type === 'costume' ? 'filled-costume' : 'filled-rod') : ''}" id="anvil-rod-slot" title="Çıkarmak için tıkla">
                            <div class="anvil-slot-label">${slotLabelText}</div>
                            <div id="anvil-rod-slot-icon" class="anvil-slot-icon-wrap"></div>
                            <div class="anvil-slot-name" id="anvil-rod-slot-name">${targetItem ? `${targetItem.name} (+${currentStep})` : 'Envanterden Eşya Seç'}</div>
                        </div>

                        <div class="anvil-plus-symbol">+</div>

                        <div class="anvil-slot-box ${scrollItem ? 'filled-scroll' : ''}" id="anvil-scroll-slot" title="Çıkarmak için tıkla">
                            <div class="anvil-slot-label">2. EFSUN KAĞIDI</div>
                            <div id="anvil-scroll-slot-icon" class="anvil-slot-icon-wrap"></div>
                            <div class="anvil-slot-name" id="anvil-scroll-slot-name">${scrollItem ? `${scrollItem.name} (x${selectedScrollEntry.count})` : 'Envanterden Kağıt Seç'}</div>
                        </div>

                        <div class="anvil-plus-symbol" style="color:#00f5d4; font-size:15px;">🛡️</div>

                        <div class="anvil-slot-box ${protectItem ? 'filled-protect' : ''}" id="anvil-protect-slot" title="Çıkarmak için tıkla">
                            <div class="anvil-slot-label" style="color:#00f5d4;">3. KORUMA (OPSİYONEL)</div>
                            <div id="anvil-protect-slot-icon" class="anvil-slot-icon-wrap"></div>
                            <div class="anvil-slot-name" id="anvil-protect-slot-name" style="${protectItem ? 'color:#00f5d4;' : ''}">${protectItem ? `${protectItem.name} (x${selectedProtectEntry.count})` : 'Parşömen (İsteğe Bağlı)'}</div>
                        </div>
                    </div>

                    <div id="anvil-details-area" style="width:100%;"></div>

                    <button class="action-btn primary btn-upgrade-bar" id="anvil-upgrade-btn" ${(!targetItem || !scrollItem || currentStep >= MAX_ENCHANT_COUNT) ? 'disabled' : ''}>
                        <div class="btn-progress-fill" id="anvil-btn-progress"></div>
                        <span class="btn-text" id="anvil-btn-text">${!targetItem ? 'Önce Envanterden Olta veya Kostüm Seçin' : !scrollItem ? 'Envanterden Efsun Kağıdı Seçin' : currentStep >= MAX_ENCHANT_COUNT ? 'Maksimum Efsun Sınırında (5/5)' : `🔨 ${targetItem.name} (+${currentStep} ➔ +${currentStep + 1}) Efsun Bas (%${nextChance})`}</span>
                    </button>
                </div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🎒 Envanterin (${player.inventory.length} / 24)</h3>
                    <span style="font-size:11.5px; color:#ffd166;">Olta, Kostüm, Kağıt veya Korumaya tıkla</span>
                </div>
                <div class="slot-grid" id="anvil-inventory-grid"></div>
                <div class="bag-subhint" id="anvil-inv-hint">
                    💡 İpucu: Kuşandığın oltaya, kostümlerine, efsun kağıtlarına veya koruma parşömenine tıklayarak örse koyabilirsin.
                </div>
            </div>
        </div>
    `;

    // Slot ikonlarını yerleştir ve tıklayınca slottan çıkarma ekle
    const rodSlotIcon = document.getElementById('anvil-rod-slot-icon');
    if (targetItem) {
        rodSlotIcon.appendChild(createItemIconCanvas(targetItem));
    } else {
        rodSlotIcon.innerHTML = `<span style="font-size:26px; opacity:0.35;">🎣</span>`;
    }
    document.getElementById('anvil-rod-slot').onclick = () => {
        if (anvilState.itemUid || anvilState.rodUid) {
            anvilState.itemUid = null;
            anvilState.rodUid = null;
            renderAnvilModal(container);
        }
    };

    const scrollSlotIcon = document.getElementById('anvil-scroll-slot-icon');
    if (scrollItem) {
        scrollSlotIcon.appendChild(createItemIconCanvas(scrollItem));
    } else {
        scrollSlotIcon.innerHTML = `<span style="font-size:26px; opacity:0.35;">📜</span>`;
    }
    document.getElementById('anvil-scroll-slot').onclick = () => {
        if (anvilState.scrollId) {
            anvilState.scrollId = null;
            renderAnvilModal(container);
        }
    };

    const protectSlotIcon = document.getElementById('anvil-protect-slot-icon');
    if (protectItem) {
        protectSlotIcon.appendChild(createItemIconCanvas(protectItem));
    } else {
        protectSlotIcon.innerHTML = `<span style="font-size:26px; opacity:0.35;">🛡️</span>`;
    }
    document.getElementById('anvil-protect-slot').onclick = () => {
        if (anvilState.protectScrollId) {
            anvilState.protectScrollId = null;
            renderAnvilModal(container);
        }
    };

    // Detay ve Başarı Oranı Kutusu
    const detailsArea = document.getElementById('anvil-details-area');
    if (!targetItem) {
        detailsArea.innerHTML = `
            <div class="empty-notice" style="padding:10px 8px; font-size:11.5px; line-height:1.4;">
                Örste henüz eşya yok. Sağdaki <b>Envanterinden</b> + basmak istediğin <b>Olta veya Kostüme</b> tıkla.<br>
                <span style="color:#ffd166; font-size:11px;">(Tüm oltalar ve kostümler Efsun Kağıtları ile +5 seviyesine kadar güçlendirilebilir!)</span>
            </div>
        `;
    } else {
        let bonusParts = [];
        if (anvilPatronLv > 0) bonusParts.push(`+%${anvilPatronLv} Patron`);
        if (guildAlchemistBonus > 0) bonusParts.push(`+%${guildAlchemistBonus.toFixed(1)} Lonca`);
        if (costumeAnvilBonus > 0) bonusParts.push(`+%${costumeAnvilBonus} Kraliyet`);
        const patronBonusText = bonusParts.length > 0 ? ` <span style="color:#ffd166;">(%${baseChance} Temel ${bonusParts.join(' ')})</span>` : '';
        const protectStatusText = protectItem
            ? `<div style="margin-top:4px; font-size:12px; color:#00f5d4; font-weight:600;">
                   🛡️ <b>Yükseltme Koruması AKTİF!</b> Başarılı olursa parşömen harcanmaz. Başarısız olursa parşömen harcanır ve eşya silinmek yerine +0'a düşer.
               </div>`
            : `<div style="margin-top:4px; font-size:11.5px; color:#ffb3c1;">
                   ${GAME_RULES.destroyRodOnFail
                       ? `⚠️ <b>Korumasız Basım:</b> Efsun başarısız olursa <b>${targetItem.name} parçalanır ve yok olur!</b> (3. Slota Koruma Parşömeni koyarak eşyanı güvenceye alabilirsin)`
                       : `🛡️ Güvenli Mod Aktif: Başarısız olursa eşya silinmez.`}
               </div>`;

        const rateHtml = currentStep >= MAX_ENCHANT_COUNT
            ? `<div class="anvil-rate-box" style="border-color:#80ed99; color:#80ed99; background:rgba(82,183,136,0.15);">
                   ✨ Bu eşya maksimum efsun sınırına (${MAX_ENCHANT_COUNT} / ${MAX_ENCHANT_COUNT}) ulaştı!
               </div>`
            : `<div class="anvil-rate-box">
                   <div>🎯 <b>+${currentStep + 1}. Efsun Başarı İhtimali: %${nextChance}</b>${patronBonusText}</div>
                   ${protectStatusText}
               </div>`;

        detailsArea.innerHTML = `
            <div style="font-size:15px; font-weight:700; color:#ffd166;">Seçili Eşya: ${targetItem.name} (+${currentStep})</div>
            <div style="font-size:12.5px; color:#c77dff; margin:4px 0 8px;">${getRodEnchantSummary(selectedItemEntry)}</div>
            ${scrollItem ? `<div style="font-size:12px; color:#80ed99; margin-bottom:4px;">📜 Basılacak Kağıt: <b>${scrollItem.name}</b> (${scrollItem.desc})</div>` : ''}
            ${protectItem ? `<div style="font-size:12px; color:#00f5d4; margin-bottom:6px;">🛡️ Kullanılan Koruma: <b>${protectItem.name}</b></div>` : ''}
            ${rateHtml}
        `;
    }

    // Sağ Panel: Envanter Slotları (24 Slot)
    const invGrid = document.getElementById('anvil-inventory-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';

        const entry = player.inventory[i];
        if (entry && ITEMS[entry.id]) {
            const item = ITEMS[entry.id];
            const wrap = document.createElement('div');
            wrap.className = 'slot-item-icon';
            wrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(wrap);

            if (entry.count > 1) {
                const c = document.createElement('span');
                c.className = 'item-count';
                c.textContent = `x${entry.count}`;
                slotDiv.appendChild(c);
            }

            const isEquipped = (item.type === 'rod' && ((entry.uid && player.equipped.rodUid === entry.uid) || (!entry.uid && player.equipped.rod === item.id))) ||
                               (item.type === 'costume' && ((entry.uid && player.equipped.costumeUid === entry.uid) || (!entry.uid && player.equipped.costume === item.id)));
            if (isEquipped) {
                const badge = document.createElement('span');
                badge.className = 'equipped-badge';
                badge.textContent = 'E';
                slotDiv.appendChild(badge);
            }

            if (item.type === 'rod' || item.type === 'costume') {
                const e = getEntryEnchants(entry);
                if (e && e.count > 0) {
                    const eb = document.createElement('span');
                    eb.className = 'enchant-badge';
                    eb.textContent = `+${e.count}`;
                    slotDiv.appendChild(eb);
                }
            }

            const isSelectedTarget = (item.type === 'rod' || item.type === 'costume') && entry.uid && (anvilState.itemUid === entry.uid || anvilState.rodUid === entry.uid);
            const isSelectedScroll = item.type === 'scroll' && anvilState.scrollId === item.id;
            const isSelectedProtect = (item.id === 'scroll_protection' || item.type === 'protect_scroll') && anvilState.protectScrollId === item.id;

            if (isSelectedTarget) {
                slotDiv.style.borderColor = '#ffd166';
                slotDiv.style.boxShadow = '0 0 12px rgba(255, 209, 102, 0.6)';
            } else if (isSelectedScroll) {
                slotDiv.style.borderColor = '#c77dff';
                slotDiv.style.boxShadow = '0 0 12px rgba(199, 125, 255, 0.6)';
            } else if (isSelectedProtect) {
                slotDiv.style.borderColor = '#00f5d4';
                slotDiv.style.boxShadow = '0 0 12px rgba(0, 245, 212, 0.6)';
            } else if (item.type !== 'rod' && item.type !== 'costume' && item.type !== 'scroll' && item.id !== 'scroll_protection' && item.type !== 'protect_scroll') {
                slotDiv.style.opacity = '0.35';
            }

            slotDiv.title = (item.type === 'rod' || item.type === 'costume')
                ? `${item.name} (Örse koymak için tıkla)`
                : item.type === 'scroll'
                ? `${item.name} (Efsun kağıdı olarak seçmek için tıkla)`
                : (item.id === 'scroll_protection' || item.type === 'protect_scroll')
                ? `${item.name} (Koruma slotuna koymak için tıkla)`
                : `${item.name} (Örste sadece Olta, Kostüm, Kağıt ve Koruma Parşömeni kullanılır)`;

            slotDiv.onclick = () => {
                if (anvilState.isForging) return;
                if (item.type === 'rod' || item.type === 'costume') {
                    if (!entry.uid) entry.uid = generateItemUid();
                    const isAlreadySelected = (anvilState.itemUid === entry.uid || anvilState.rodUid === entry.uid);
                    anvilState.itemUid = isAlreadySelected ? null : entry.uid;
                    anvilState.rodUid = anvilState.itemUid;
                    renderAnvilModal(container);
                } else if (item.type === 'scroll') {
                    anvilState.scrollId = anvilState.scrollId === item.id ? null : item.id;
                    renderAnvilModal(container);
                } else if (item.id === 'scroll_protection' || item.type === 'protect_scroll') {
                    anvilState.protectScrollId = anvilState.protectScrollId === item.id ? null : item.id;
                    renderAnvilModal(container);
                } else {
                    showToast('⚠️ Efsunlu Örs\'e yalnızca Olta, Kostüm, Efsun Kağıdı veya Koruma Parşömeni koyabilirsin!', '#ffbe0b');
                }
            };
        }

        invGrid.appendChild(slotDiv);
    }

    // + Bas Butonu
    const upBtn = document.getElementById('anvil-upgrade-btn');
    if (upBtn) {
        upBtn.onclick = () => {
            if (anvilState.isForging) return;
            if (!selectedItemEntry || !targetItem || !selectedScrollEntry || !scrollItem) return;
            if (currentStep >= MAX_ENCHANT_COUNT) {
                showToast(`⚠️ Bu eşyaya zaten maksimum (${MAX_ENCHANT_COUNT}) efsun basıldı!`, '#ffbe0b');
                return;
            }

            anvilState.isForging = true;
            upBtn.disabled = true;

            const rodSlot = document.getElementById('anvil-rod-slot');
            const fillEl = document.getElementById('anvil-btn-progress');
            const textEl = document.getElementById('anvil-btn-text');

            if (fillEl) fillEl.classList.add('active');

            const startTime = performance.now();
            const duration = 1500;

            function animateForging(now) {
                const elapsed = now - startTime;
                const progress = Math.min(1, elapsed / duration);
                const pct = Math.floor(progress * 100);
                if (fillEl) fillEl.style.width = `${pct}%`;
                if (textEl) textEl.textContent = `⚡ Efsun İşleniyor... %${pct}`;

                if (progress < 1) {
                    requestAnimationFrame(animateForging);
                } else {
                    // 1 adet Efsun Kağıdı harca
                    removeItemFromInventory(scrollItem.id, 1);

                    const hasProtection = Boolean(protectItem);

                    const roll = Math.random() * 100;
                    if (roll < nextChance) {
                        const e = getEntryEnchants(selectedItemEntry);
                        e.count += 1;
                        e[scrollItem.scrollStat] = (e[scrollItem.scrollStat] || 0) + scrollItem.scrollValue;
                        selectedItemEntry.enchants = e;

                        if (targetItem.type === 'costume') {
                            player.costumeEnchants = player.costumeEnchants || {};
                            player.costumeEnchants[targetItem.id] = { ...e };
                            try { localStorage.setItem('mmo_costume_enchants', JSON.stringify(player.costumeEnchants)); } catch(err) {}
                        } else {
                            player.rodEnchants[targetItem.id] = { ...e };
                        }

                        if (rodSlot) rodSlot.classList.add('flash-success');
                        if (textEl) textEl.textContent = `✨ BAŞARILI! (${targetItem.name} +${e.count}) ✨`;
                        upBtn.style.borderColor = '#80ed99';
                        upBtn.style.color = '#80ed99';
                        showToast(`✨ BAŞARILI! ${targetItem.name} (+${e.count}) efsunlandı!${hasProtection ? ' (Koruma Parşömeni korundu)' : ''}`, '#80ed99');
                    } else {
                        if (rodSlot) rodSlot.classList.add('smoke-failed');

                        if (hasProtection) {
                            // Koruma parşömeni yalnızca başarısızlıkta harcanarak eşyayı kurtarır, eşya +0'a düşer
                            removeItemFromInventory('scroll_protection', 1);

                            const resetEnch = { count: 0, luck: 0, speed: 0, control: 0 };
                            selectedItemEntry.enchants = resetEnch;
                            if (targetItem.type === 'costume') {
                                if (player.costumeEnchants) player.costumeEnchants[targetItem.id] = { ...resetEnch };
                            } else {
                                player.rodEnchants[targetItem.id] = { ...resetEnch };
                            }
                            if (!player.inventory.some(i => i.id === 'scroll_protection')) {
                                anvilState.protectScrollId = null;
                            }
                            if (textEl) textEl.textContent = `🛡️ KORUNDU (+0'a Düştü)`;
                            upBtn.style.borderColor = '#ffd166';
                            upBtn.style.color = '#ffd166';
                            showToast(`🛡️ KORUMA DEVREYE GİRDİ! Parşömen harcandı; ${targetItem.name} silinmedi ancak +0 seviyesine düştü!`, '#ffbe0b');
                        } else {
                            if (GAME_RULES.destroyRodOnFail) {
                                const brokenName = `${targetItem.name}${currentStep > 0 ? ` (+${currentStep})` : ''}`;
                                if (targetItem.type === 'costume') {
                                    if (player.equipped.costume === targetItem.id) {
                                        player.equipped.costume = null;
                                        player.equipped.costumeUid = null;
                                    }
                                } else if (targetItem.type === 'rod') {
                                    if (player.equipped.rodUid === selectedItemEntry.uid || player.equipped.rod === targetItem.id) {
                                        player.equipped.rod = null;
                                        player.equipped.rodUid = null;
                                    }
                                }
                                removeItemByUid(selectedItemEntry.uid);
                                anvilState.itemUid = null;
                                anvilState.rodUid = null;
                                if (textEl) textEl.textContent = `💥 YANDI! ${brokenName} parçalandı! 💥`;
                                upBtn.style.borderColor = '#d90429';
                                upBtn.style.color = '#ffb3c1';
                                showToast(`💥 EFSUN BAŞARISIZ OLDU! ${brokenName} parçalandı ve tamamen silindi!`, '#ff595e');
                            } else {
                                if (textEl) textEl.textContent = `⚠️ Efsun başarısız oldu! (${targetItem.typeName || 'Eşya'} korundu)`;
                                upBtn.style.borderColor = '#d90429';
                                upBtn.style.color = '#ffb3c1';
                                showToast(`⚠️ Efsun başarısız oldu! (${targetItem.name} korundu)`, '#ffbe0b');
                            }
                        }
                    }

                    setTimeout(() => {
                        anvilState.isForging = false;
                        renderAnvilModal(container);
                        renderInventoryUI();
                        renderBuffBar();
                    }, 1200);
                }
            }
            requestAnimationFrame(animateForging);
        };
    }
}

// 7) BAHİSÇİ BÜLO (Ölü Denizcinin Hazinesini Açma & Hazine Sandığı Kumarı)
function renderGamblerModal(container) {
    const treasureEntry = player.inventory.find(i => i.id === 'item_dead_sailor_treasure');
    const treasureCount = treasureEntry ? treasureEntry.count : 0;
    const hasPlaced = gamblerState.treasurePlaced && treasureCount > 0;
    const protectEntry = player.inventory.find(i => i.id === 'scroll_protection');
    const protectCount = protectEntry ? protectEntry.count : 0;
    const pearlEntry = player.inventory.find(i => i.id === 'item_pearl');
    const pearlCount = pearlEntry ? pearlEntry.count : 0;

    const guildGamblerLv = getGuildSkillLevel('guild_gambler');
    const guildGamblerBonus = guildGamblerLv * 0.5; // Lonca Kumarbazı: Seviye başına +%0.5 İnci & Koruma
    const costumeGamblerBonus = getEquippedCostumeItem()?.gamblerBonus || 0; // Kraliyet Muhafızı: +%5 Bahisçi Şansı
    const pChance = Number(GAME_RULES.gamblerProtectScrollChance ?? 1.0) + guildGamblerBonus + costumeGamblerBonus;
    const pearlChance = Number(GAME_RULES.gamblerPearlChance ?? 1.0) + guildGamblerBonus + costumeGamblerBonus;
    const emptyChance = Math.max(0, 100 - (pChance + pearlChance));
    const winChance = pChance + pearlChance;

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🎲 Hazine Kumar Masası</h3>
                    <span style="font-size:11.5px; color:#ffd166;">Sağdaki çantandan Sandığı masaya koy</span>
                </div>
                <div class="gambler-stage">
                    <p style="color:#ced4da; font-size:13px; line-height:1.5; margin:0 0 10px;">
                        <i>"Vay vay genç balıkçı! Okyanusun dibinden çıkardığın o lanetli <b>Ölü Denizcinin Hazinesi</b> sandıklarını bana getir. Paslı kilidini kırayım. Kim bilir, belki de %${pearlChance} ihtimalle <b>İnci</b> ya da %${pChance} ihtimalle efsanevi <b>Kaybolma Koruması Parşömeni</b> sana güler!"</i>
                    </p>

                    <div class="gambler-slot-box ${hasPlaced ? 'filled-treasure' : ''}" id="gambler-treasure-slot" title="Masaya koymak / kaldırmak için tıkla">
                        <div class="anvil-slot-label">ÖLÜ DENİZCİNİN HAZİNESİ</div>
                        <div id="gambler-slot-icon" style="margin:8px 0;"></div>
                        <div class="anvil-slot-name">${hasPlaced ? `Ölü Denizcinin Hazinesi (Kalan: x${treasureCount})` : 'Envanterden Hazine Sandığı Seç'}</div>
                        <div style="font-size:11px; color:#adb5bd; margin-top:4px;">${hasPlaced ? 'Sandık masada hazır! (Kaldırmak için tıkla)' : 'Sağdaki çantandan sandığa tıkla'}</div>
                    </div>

                    <div class="gambler-odds-box">
                        <div style="font-weight:700; color:#ffd166; margin-bottom:6px; font-size:13px;">🎁 Olası İhtimaller:</div>
                        <div class="odds-row fail">
                            <span>💨 %${emptyChance.toFixed(1)} İhtimalle:</span>
                            <b>Hazine Boş Çıktı (Tuzlu yosun ve paslı çivi)</b>
                        </div>
                        <div class="odds-row pearl">
                            <span>🦪 %${pearlChance.toFixed(1)} İhtimalle:</span>
                            <b style="color:#90e0ef;">İnci (Değerli Craft Malzemesi)</b>
                        </div>
                        <div class="odds-row success">
                            <span>🛡️ %${pChance.toFixed(1)} İhtimalle:</span>
                            <b style="color:#00f5d4;">Kaybolma Koruması Parşömeni</b>
                        </div>
                    </div>

                    <button class="action-btn primary btn-open-chest btn-upgrade-bar" id="btn-open-gambler-chest" ${!hasPlaced ? 'disabled' : ''}>
                        <div class="btn-progress-fill gambler-fill" id="gambler-btn-progress"></div>
                        <span class="btn-text" id="gambler-btn-text">${!hasPlaced ? 'Önce Masaya Hazine Sandığı Koyun' : `🎲 Hazineyi Aç (%${winChance.toFixed(1)} Şans)`}</span>
                    </button>
                </div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🎒 Envanterin (${player.inventory.length} / 24)</h3>
                    <span style="font-size:11.5px; color:#ffd166;">Hazine Sandığına tıkla</span>
                </div>
                <div class="slot-grid" id="gambler-inventory-grid"></div>
                <div class="bag-subhint">
                    🦪 İnci: <b>${pearlCount} adet</b> • 🛡️ Koruma: <b>${protectCount} adet</b> • 🏴‍☠️ Hazine: <b>${treasureCount} adet</b>
                </div>
            </div>
        </div>
    `;

    const iconBox = document.getElementById('gambler-slot-icon');
    if (hasPlaced && ITEMS.item_dead_sailor_treasure) {
        iconBox.appendChild(createItemIconCanvas(ITEMS.item_dead_sailor_treasure));
    } else {
        iconBox.innerHTML = `<span style="font-size:36px; opacity:0.35;">🏴‍☠️</span>`;
    }

    document.getElementById('gambler-treasure-slot').onclick = () => {
        if (gamblerState.treasurePlaced) {
            gamblerState.treasurePlaced = false;
            renderGamblerModal(container);
        }
    };

    // Sağ Panel: Envanter Slotları
    const invGrid = document.getElementById('gambler-inventory-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';

        const entry = player.inventory[i];
        if (entry && ITEMS[entry.id]) {
            const item = ITEMS[entry.id];
            const wrap = document.createElement('div');
            wrap.className = 'slot-item-icon';
            wrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(wrap);

            if (entry.count > 1) {
                const c = document.createElement('span');
                c.className = 'item-count';
                c.textContent = `x${entry.count}`;
                slotDiv.appendChild(c);
            }

            const isChest = item.id === 'item_dead_sailor_treasure';
            if (isChest) {
                slotDiv.style.borderColor = '#ffd166';
                slotDiv.style.boxShadow = '0 0 12px rgba(255, 209, 102, 0.65)';
                slotDiv.title = `${item.name} (Masaya koymak için tıkla)`;
            } else {
                slotDiv.style.opacity = '0.35';
                slotDiv.title = `${item.name} (Bahisçi Bülo yalnızca Ölü Denizcinin Hazinesi açabilir)`;
            }

            slotDiv.onclick = () => {
                if (gamblerState.isOpening) return;
                if (isChest) {
                    gamblerState.treasurePlaced = !gamblerState.treasurePlaced;
                    renderGamblerModal(container);
                } else {
                    showToast('⚠️ Bahisçi Bülo yalnızca Ölü Denizcinin Hazinesi sandıklarını açabilir!', '#ffbe0b');
                }
            };
        }
        invGrid.appendChild(slotDiv);
    }

    const openBtn = document.getElementById('btn-open-gambler-chest');
    if (openBtn && hasPlaced) {
        openBtn.onclick = () => {
            if (gamblerState.isOpening) return;
            if (!player.inventory.some(i => i.id === 'item_dead_sailor_treasure')) {
                showToast('⚠️ Çantanda Ölü Denizcinin Hazinesi kalmadı!', '#ff595e');
                gamblerState.treasurePlaced = false;
                renderGamblerModal(container);
                return;
            }

            gamblerState.isOpening = true;
            openBtn.disabled = true;

            const chestSlot = document.getElementById('gambler-treasure-slot');
            const fillEl = document.getElementById('gambler-btn-progress');
            const textEl = document.getElementById('gambler-btn-text');

            if (fillEl) fillEl.classList.add('active');

            const startTime = performance.now();
            const duration = 1500;

            function animateGambler(now) {
                const elapsed = now - startTime;
                const progress = Math.min(1, elapsed / duration);
                const pct = Math.floor(progress * 100);
                if (fillEl) fillEl.style.width = `${pct}%`;
                if (textEl) textEl.textContent = `🗝️ Kilit Kırılıyor... %${pct}`;

                if (progress < 1) {
                    requestAnimationFrame(animateGambler);
                } else {
                    removeItemFromInventory('item_dead_sailor_treasure', 1);
                    const roll = Math.random() * 100;
                    const guildGamblerLv = getGuildSkillLevel('guild_gambler');
                    const guildGamblerBonus = guildGamblerLv * 0.5;
                    const pChance = Number(GAME_RULES.gamblerProtectScrollChance ?? 1.0) + guildGamblerBonus;
                    const pearlChance = Number(GAME_RULES.gamblerPearlChance ?? 1.0) + guildGamblerBonus;

                    if (roll < pChance) {
                        // Koruma Parşömeni
                        addItemToInventory('scroll_protection', 1);
                        if (chestSlot) chestSlot.classList.add('flash-success');
                        if (textEl) textEl.textContent = `🌟 PARŞÖMEN BULUNDU! 🌟`;
                        openBtn.style.borderColor = '#00f5d4';
                        openBtn.style.color = '#00f5d4';
                        showToast(`🎉 BÜYÜK ŞANS! Hazine sandığından [Kaybolma Koruması Parşömeni] (%${pChance}) ÇIKTI!`, '#00f5d4');
                    } else if (roll < (pChance + pearlChance)) {
                        // İnci
                        addItemToInventory('item_pearl', 1);
                        if (chestSlot) chestSlot.classList.add('flash-success');
                        if (textEl) textEl.textContent = `🦪 PARLAK İNCİ ÇIKTI! 🦪`;
                        openBtn.style.borderColor = '#90e0ef';
                        openBtn.style.color = '#90e0ef';
                        showToast(`🦪 TEBRİKLER! Hazine sandığından kadim [İnci] (%${pearlChance}) ÇIKTI!`, '#90e0ef');
                    } else {
                        // Boş
                        if (chestSlot) chestSlot.classList.add('smoke-failed');
                        if (textEl) textEl.textContent = `💨 Hazine Boş Çıktı...`;
                        openBtn.style.borderColor = '#d90429';
                        openBtn.style.color = '#ffb3c1';
                        showToast('💨 Sandıktan sadece değersiz yosun ve paslı çiviler çıktı...', '#adb5bd');
                    }

                    setTimeout(() => {
                        gamblerState.isOpening = false;
                        const rem = player.inventory.find(i => i.id === 'item_dead_sailor_treasure');
                        if (!rem || rem.count <= 0) {
                            gamblerState.treasurePlaced = false;
                        }
                        renderGamblerModal(container);
                        renderInventoryUI();
                        renderBuffBar();
                    }, 1200);
                }
            }
            requestAnimationFrame(animateGambler);
        };
    }
}

// 8) MUHTAR AHMET (Köy Görevleri & Balık Avı Ödül Bürosu)
function renderHeadmanModal(container) {
    let questCardsHtml = '';

    QUESTS.forEach(q => {
        const reqItem = ITEMS[q.requiredItem] || { name: q.requiredItem, type: 'fish' };
        const rewItem = ITEMS[q.rewardItem] || { name: q.rewardItem, type: 'material' };
        const currentCount = getItemCountInInventory(q.requiredItem);
        const isReady = currentCount >= q.requiredCount;
        const pct = Math.min(100, Math.floor((currentCount / q.requiredCount) * 100));

        questCardsHtml += `
            <div class="quest-card ${isReady ? 'ready-to-turn-in' : ''}">
                <div class="quest-card-header">
                    <div class="quest-title-badge">
                        <span class="quest-star">⭐</span>
                        <h4 class="quest-title">${q.title}</h4>
                    </div>
                    <span class="quest-reward-tag">Ödül: ${q.rewardCount}x ${rewItem.name}</span>
                </div>
                <div class="quest-desc">${q.desc}</div>

                <div class="quest-requirements-box">
                    <div class="quest-req-line">
                        <span class="quest-req-item">
                            <span class="quest-req-icon">${reqItem.type === 'fish' ? '🐟' : '📦'}</span>
                            <b>${reqItem.name}</b>
                        </span>
                        <span class="quest-req-counter ${isReady ? 'counter-ok' : ''}">
                            ${currentCount} / ${q.requiredCount} ${isReady ? '✓ (Hazır)' : ''}
                        </span>
                    </div>
                    <div class="quest-progress-track">
                        <div class="quest-progress-fill ${isReady ? 'fill-ready' : ''}" style="width: ${pct}%;"></div>
                    </div>
                </div>

                <div class="quest-reward-row">
                    <div class="quest-reward-preview">
                        <span style="font-size:16px;">🎁</span>
                        <span>Ödül: <b>${q.rewardCount}x ${rewItem.name}</b></span>
                    </div>
                    <button class="action-btn ${isReady ? 'success quest-submit-btn' : 'disabled'}"
                            data-qid="${q.id}"
                            ${!isReady ? 'disabled' : ''}>
                        ${isReady ? `✅ Görevi Teslim Et (+${q.rewardCount} Ödül)` : `⚠️ Yetersiz (${currentCount}/${q.requiredCount})`}
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="npc-panel" style="max-height: 560px; overflow-y: auto;">
            <div class="npc-panel-header" style="flex-direction:column; align-items:flex-start; gap:4px;">
                <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                    <h3>📜 Muhtar Ahmet'in Görev Bürosu</h3>
                    <span style="font-size:11.5px; color:#80ed99; font-weight:700;">🟢 Serbest Teslimat</span>
                </div>
                <p style="margin:2px 0 0; font-size:12.5px; color:#ced4da; line-height:1.45;">
                    <i>"Hoş geldin balıkçı kardeşim! Akdeniz sularında köyümüz adına avlanan usta balıkçılara hak ettikleri ödülleri dağıtıyorum. Görevleri önceden almana gerek yoktur; gereken balıkları tuttuğunda getir, hemen ödülünü teslim al!"</i>
                </p>
            </div>

            <div class="headman-quests-grid">
                ${questCardsHtml}
            </div>
        </div>
    `;

    // Görev teslim butonları
    container.querySelectorAll('.quest-submit-btn').forEach(btn => {
        btn.onclick = () => {
            const qid = btn.getAttribute('data-qid');
            const q = QUESTS.find(item => item.id === qid);
            if (!q) return;

            const currentCount = getItemCountInInventory(q.requiredItem);
            if (currentCount < q.requiredCount) {
                showToast(`⚠️ Yetersiz balık! ${q.requiredCount} adet ${ITEMS[q.requiredItem]?.name || ''} gereklidir.`, '#ff595e');
                return;
            }

            // Çanta doluluk kontrolü
            const hasRewardAlready = player.inventory.some(i => i.id === q.rewardItem);
            if (!hasRewardAlready && player.inventory.length >= 24) {
                showToast('⚠️ Çantan tamamen dolu! Ödülü alabilmek için çantanda en az 1 boş slot açmalısın.', '#ff595e');
                return;
            }

            // Balıkları envanterden düş
            removeMultipleFromInventory(q.requiredItem, q.requiredCount);

            // Ödülü çantaya ver
            addItemToInventory(q.rewardItem, q.rewardCount);

            // UI'ları tazele
            renderHeadmanModal(container);
            renderInventoryUI();
            renderBuffBar();

            const rewItemName = ITEMS[q.rewardItem]?.name || 'Ödül';
            showToast(`🎉 GÖREV TAMAMLANDI! [${q.title}] teslim edildi. +${q.rewardCount}x ${rewItemName} kazandın!`, '#80ed99');
        };
    });
}

// ============================================================================
// 9. YOL BULMA (A*) & MOUSE / KLAVYE KONTROLLERİ
// ============================================================================
function findPath(startX, startY, goalX, goalY) {
    const sx = Math.floor(startX);
    const sy = Math.floor(startY);
    let gx = Math.floor(goalX);
    let gy = Math.floor(goalY);

    if (!isWalkable(gx, gy)) {
        let bestTile = null;
        let bestDist = 999;
        for (let r = 1; r <= 6; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    const nx = gx + dx;
                    const ny = gy + dy;
                    if (isWalkable(nx, ny)) {
                        const d = Math.hypot((nx + 0.5) - goalX, (ny + 0.5) - goalY);
                        if (d < bestDist) {
                            bestDist = d;
                            bestTile = { x: nx, y: ny };
                        }
                    }
                }
            }
            if (bestTile) break;
        }
        if (!bestTile) return [];
        gx = bestTile.x;
        gy = bestTile.y;
    }

    if (sx === gx && sy === gy) {
        return [{ x: gx + 0.5, y: gy + 0.5 }];
    }

    const open = [{ x: sx, y: sy, g: 0, h: Math.hypot(gx - sx, gy - sy), parent: null }];
    const closed = new Set();
    const key = (x, y) => `${x},${y}`;
    const dirs = [
        { dx: 1, dy: 0, c: 1 }, { dx: -1, dy: 0, c: 1 },
        { dx: 0, dy: 1, c: 1 }, { dx: 0, dy: -1, c: 1 },
        { dx: 1, dy: 1, c: 1.41 }, { dx: -1, dy: 1, c: 1.41 },
        { dx: 1, dy: -1, c: 1.41 }, { dx: -1, dy: -1, c: 1.41 }
    ];

    let iterations = 0;
    while (open.length > 0 && iterations < 600) {
        iterations++;
        open.sort((a, b) => (a.g + a.h) - (b.g + b.h));
        const cur = open.shift();

        if (cur.x === gx && cur.y === gy) {
            const path = [];
            let node = cur;
            while (node.parent) {
                path.unshift({ x: node.x + 0.5, y: node.y + 0.5 });
                node = node.parent;
            }
            return path;
        }

        closed.add(key(cur.x, cur.y));

        for (const d of dirs) {
            const nx = cur.x + d.dx;
            const ny = cur.y + d.dy;
            if (!isWalkable(nx, ny) || closed.has(key(nx, ny))) continue;
            if (d.dx !== 0 && d.dy !== 0) {
                if (!isWalkable(cur.x + d.dx, cur.y) || !isWalkable(cur.x, cur.y + d.dy)) continue;
            }
            const gScore = cur.g + d.c;
            const existing = open.find(o => o.x === nx && o.y === ny);
            if (!existing) {
                open.push({ x: nx, y: ny, g: gScore, h: Math.hypot(gx - nx, gy - ny), parent: cur });
            } else if (gScore < existing.g) {
                existing.g = gScore;
                existing.parent = cur;
            }
        }
    }
    return [];
}

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (isAnyModalOpen()) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const playerIso = tileToScreen(player.x, player.y);
    const camX = viewWidth / 2 - playerIso.x;
    const camY = viewHeight / 2 - playerIso.y;

    const m = getActiveMap();
    let clickedInteractable = null;
    for (const inter of m.interactables) {
        const iPos = tileToScreen(inter.x, inter.y);
        const sx = iPos.x + camX;
        const sy = iPos.y + camY;
        if (Math.hypot(clickX - sx, clickY - (sy - 24)) < 38) {
            clickedInteractable = inter;
            break;
        }
    }

    const targetTile = clickedInteractable
        ? { x: clickedInteractable.x, y: clickedInteractable.y }
        : screenToTile(clickX, clickY, camX, camY);

    if (clickedInteractable && Math.hypot(clickedInteractable.x - player.x, clickedInteractable.y - player.y) <= 2.3) {
        interactWithObject(clickedInteractable);
        return;
    }

    // Kraken Haritasında Lonca Gemisi Kontrol Kısıtlaması: Sadece Lonca Lideri dümene geçebilir!
    if (currentMapId === 'kraken' && !isPlayerGuildLeader()) {
        if (fishing.state === 'IDLE') {
            if (player.equipped.rod) {
                handleSpaceAction();
            } else {
                showToast("⚓ Tekne dümeni Lonca Lideri'ndedir! Üyeler gemiyi süremez, yalnızca güverteden olta atabilir (Önce bir olta kuşan).", '#4cc9f0');
            }
        } else if (fishing.state === 'MINIGAME' || fishing.state === 'WAITING') {
            handleSpaceAction();
        } else {
            showToast("⚓ Tekne dümeni Lonca Lideri'ndedir! Üyeler gemiyi hareket ettiremez, yalnızca güverteden olta atabilir (SPACE / O).", '#4cc9f0');
        }
        return;
    }

    const path = findPath(player.x, player.y, targetTile.x, targetTile.y);
    if (path.length > 0) {
        if (autoHunt.active) {
            stopAutoHunt('Hareket ettiğin için Auto-Hunt durduruldu.');
        } else if (fishing.state !== 'IDLE') {
            cancelFishing('Hareket ettiğin için balık tutma iptal oldu.');
        }
        player.path = path;
        player.pendingInteraction = clickedInteractable;
        const last = path[path.length - 1];
        player.targetMarker = { x: last.x, y: last.y, timer: 1.2 };
    }
});

window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.code === 'Escape') {
            document.activeElement.blur();
            if (document.activeElement?.id === 'chat-input') {
                closeChatInput();
            }
        }
        return;
    }

    if (e.code === 'KeyT') {
        e.preventDefault();
        openChatInput();
        return;
    }

    if (e.code === 'KeyI') {
        e.preventDefault();
        toggleInventory();
    } else if (e.code === 'KeyK') {
        e.preventDefault();
        toggleSkillTree();
    } else if (e.code === 'KeyP') {
        e.preventDefault();
        if (currentUser && currentUser.role === 'admin') {
            toggleAdminPanel();
        } else {
            showToast('⛔ Kontrol Paneli sadece Yönetici (GM) hesabına açıktır.', '#ff595e');
        }
    } else if (e.code === 'KeyG') {
        e.preventDefault();
        toggleGuildWindow();
    } else if (e.code === 'KeyZ') {
        e.preventDefault();
        toggleWikiModal();
    } else if (e.code === 'KeyO') {
        e.preventDefault();
        if (!isAnyModalOpen()) toggleAutoHunt();
    } else if (e.code === 'Space') {
        e.preventDefault();
        handleSpaceAction();
    } else if (e.code === 'Escape') {
        document.getElementById('inventory-modal').classList.add('hidden');
        document.getElementById('npc-modal').classList.add('hidden');
        document.getElementById('skill-modal').classList.add('hidden');
        document.getElementById('admin-modal').classList.add('hidden');
        document.getElementById('guild-modal').classList.add('hidden');
        document.getElementById('wiki-modal')?.classList.add('hidden');
        isTrashMode = false;
        selectedTrashIndices.clear();
        closeChatInput();
    }
});

// ============================================================================
// 9.4 SOHBET (CHAT) VE KARAKTER OLUŞTURMA SİSTEMİ
// ============================================================================
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function addChatMessage(author, text, type = 'player') {
    const list = document.getElementById('chat-messages');
    if (!list) return;

    const timeStr = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';

    const safeAuthor = escapeHTML(author);
    const safeText = escapeHTML(text);

    let authorClass = 'player';
    if (type === 'self') authorClass = 'self';
    else if (type === 'system') authorClass = 'system';

    msgEl.innerHTML = `
        <span class="chat-time">[${timeStr}]</span>
        <span class="chat-author ${authorClass}">${safeAuthor}:</span>
        <span class="chat-text ${type === 'system' ? 'system-text' : ''}">${safeText}</span>
    `;

    list.appendChild(msgEl);

    // En fazla 60 mesaj tut
    while (list.children.length > 60) {
        list.removeChild(list.firstChild);
    }

    // Otomatik olarak son mesaja kaydır
    list.scrollTop = list.scrollHeight;
}

function openChatInput() {
    const chatContainer = document.getElementById('chat-container');
    const chatInput = document.getElementById('chat-input');
    if (!chatContainer || !chatInput) return;

    chatContainer.classList.add('active');
    chatInput.focus();
}

function closeChatInput() {
    const chatContainer = document.getElementById('chat-container');
    const chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.blur();
    if (chatContainer) chatContainer.classList.remove('active');
}

function sendChatMessage() {
    const chatInput = document.getElementById('chat-input');
    if (!chatInput) return;

    const text = chatInput.value.trim();
    if (!text) {
        closeChatInput();
        return;
    }

    const isGM = (currentUser && currentUser.role === 'admin');
    const senderName = (isGM ? '👑 [GM] ' : '') + (player.name || 'Balıkçı');
    addChatMessage(senderName, text, isGM ? 'admin' : 'self');
    player.chatBubble = { text: text, timer: 6.0 };
    chatInput.value = '';
    closeChatInput();

    // Socket.io ile diğer tüm oyunculara canlı yayınla
    if (socket && socket.connected) {
        socket.emit('chat_send', {
            text: text,
            channel: 'all'
        });
    }
}

// Karakter Oluşturma Önizlemesi (Mini Avatar Çizimi)
function renderCharCreationPreview() {
    try {
        const canvas = document.getElementById('char-preview-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, 102);
        ctx.scale(1.4, 1.4);
        drawSmoothCharacter(ctx, 0, 0, true);
        ctx.restore();
    } catch (err) {
        console.warn('renderCharCreationPreview error:', err);
    }
}

function openCharacterCreation() {
    const modal = document.getElementById('char-create-modal');
    const input = document.getElementById('char-name-input');
    const previewTag = document.getElementById('char-preview-tag');
    const errText = document.getElementById('char-name-error');
    if (!modal || !input) return;

    modal.classList.remove('hidden');
    if (errText) errText.classList.add('hidden');
    renderCharCreationPreview();
    setTimeout(() => {
        try {
            input.focus();
            renderCharCreationPreview();
        } catch (e) {}
    }, 60);
}

function initCharacterCreationModal() {
    const modal = document.getElementById('char-create-modal');
    const input = document.getElementById('char-name-input');
    const submitBtn = document.getElementById('char-create-btn');
    const previewTag = document.getElementById('char-preview-tag');
    const errText = document.getElementById('char-name-error');

    if (!modal || !input || !submitBtn) return;

    input.addEventListener('input', () => {
        const val = input.value.trim();
        if (previewTag) previewTag.textContent = val ? `Lv.${player.level} ${val}` : `Lv.${player.level} Balıkçı`;
        if (errText) errText.classList.add('hidden');
    });

    const submitAction = async () => {
        const raw = input.value.trim();
        if (raw.length < 2 || raw.length > 16) {
            if (errText) {
                errText.textContent = 'Lütfen 2 ile 16 karakter arasında bir isim girin!';
                errText.classList.remove('hidden');
            }
            input.focus();
            return;
        }

        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.6';

        if (serverOnline && authToken) {
            try {
                const res = await fetch(getServerApiUrl('/api/character/create'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({ name: raw })
                });
                let data = null;
                try { data = await res.json(); } catch(e) {}
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';

                if (!res.ok || !data || !data.success) {
                    if (errText) {
                        errText.textContent = (data && data.message) ? data.message : 'Bu karakter adı kullanılamıyor!';
                        errText.classList.remove('hidden');
                    }
                    input.focus();
                    return;
                }

                applyLoadedCharacter(data.character);
                modal.classList.add('hidden');
                initSocketConnection();
                showToast(`🌟 Hoş geldin, ${player.name}! Dünyaya adım attın.`, '#80ed99');
                addChatMessage('Sistem', `Hoş geldin ${player.name}! Burnaz Sahil'desin. Sohbet etmek için [T] tuşuna basabilirsin.`, 'system');
                return;
            } catch (err) {
                console.warn('Sunucuya karakter kaydedilemedi, yerel modda devam ediliyor:', err);
                serverOnline = false;
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                player.name = raw;
                SafeStorage.setItem('mmo_character_name', raw);
                updateExpHUD();
                modal.classList.add('hidden');
                showToast(`⚡ Yerel Mod: Hoş geldin, ${player.name}! Dünyaya adım attın.`, '#ffd166');
                addChatMessage('Sistem', `Hoş geldin ${player.name}! (Çevrimdışı modda oynuyorsun).`, 'system');
                return;
            }
        }

        // Yerel Çevrimdışı Mod
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        player.name = raw;
        SafeStorage.setItem('mmo_character_name', raw);
        updateExpHUD();
        modal.classList.add('hidden');

        showToast(`🌟 Hoş geldin, ${player.name}! Dünyaya adım attın.`, '#80ed99');
        addChatMessage('Sistem', `Hoş geldin ${player.name}! Burnaz Sahil'desin. Sohbet etmek için [T] tuşuna basabilirsin.`, 'system');
    };

    submitBtn.onclick = submitAction;
    input.addEventListener('keydown', (e) => {
        if (e.code === 'Enter') {
            e.preventDefault();
            submitAction();
        }
    });
}

function initChatSystem() {
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const chatContainer = document.getElementById('chat-container');

    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.code === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            } else if (e.code === 'Escape') {
                e.preventDefault();
                closeChatInput();
            }
        });
        chatInput.addEventListener('focus', () => {
            if (chatContainer) chatContainer.classList.add('active');
        });
        chatInput.addEventListener('blur', () => {
            setTimeout(() => {
                if (document.activeElement !== chatInput && chatContainer) {
                    chatContainer.classList.remove('active');
                }
            }, 150);
        });
    }

    if (chatSendBtn) {
        chatSendBtn.onclick = sendChatMessage;
    }

    // İlk sistem karşılama mesajını ekle
    addChatMessage('Sistem', 'Burnaz Sahil & Dörtyol MMO dünyasına hoş geldin! Sohbet etmek için [T] tuşuna bas.', 'system');
}

// ============================================================================
// 9.45 LONCA (GUILD) SİSTEMİ & 48 SLOTLUK LONCA KASASI
// ============================================================================
let activeGuild = null;
try {
    const rawGuild = localStorage.getItem('mmo_guild_data');
    if (rawGuild) {
        activeGuild = JSON.parse(rawGuild);
    }
} catch (e) {
    console.warn('Lonca verisi okunamadı:', e);
}

// Lonca Yetenek Tanımları (1-5 Seviye)
const GUILD_SKILLS = [
    {
        id: 'guild_blessing',
        name: 'Lonca Kutsaması',
        icon: '✨',
        desc: 'Kadim denizlerin bereketi tüm loncayı sarar. Efsanevi balıkların oltaya gelme şansını artırır.',
        maxLevel: 5,
        effectPerLevel: 0.5,
        perLevelText: 'Seviye başına: +%0.5 Efsanevi Balık Şansı',
        formatBonus: (lv) => `+%$${(lv * 0.5).toFixed(1)} Efsanevi Balık Şansı`
    },
    {
        id: 'guild_alchemist',
        name: 'Lonca Simyacısı',
        icon: '⚗️',
        desc: 'Birlik simyacılarının efsun formülleri sayesinde Anvil tezgâhında olta yükseltme başarısı artar.',
        maxLevel: 5,
        effectPerLevel: 0.5,
        perLevelText: 'Seviye başına: Anvil\'de +%0.5 Başarı Şansı',
        formatBonus: (lv) => `+%$${(lv * 0.5).toFixed(1)} Anvil Başarı Oranı`
    },
    {
        id: 'guild_veteran',
        name: 'Lonca Emektarı',
        icon: '⚡',
        desc: 'Tecrübeli lonca avcılarının taktikleriyle Auto-Hunt balık bekleme süresi belirgin şekilde hızlanır.',
        maxLevel: 5,
        effectPerLevel: 5,
        perLevelText: 'Seviye başına: %5 Auto-Hunt Hızı',
        formatBonus: (lv) => `+%${lv * 5} Auto-Hunt Hızı`
    },
    {
        id: 'guild_gambler',
        name: 'Lonca Kumarbazı',
        icon: '🎲',
        desc: 'Bahisçi Bülo\'nun oyunlarında lonca üyelerine şans kapılarını aralar; İnci ve Koruma şansını artırır.',
        maxLevel: 5,
        effectPerLevel: 0.5,
        perLevelText: 'Seviye başına: +%0.5 İnci & +%0.5 Koruma Parşömeni Şansı',
        formatBonus: (lv) => `+%$${(lv * 0.5).toFixed(1)} İnci & Koruma Parşömeni`
    },
    {
        id: 'guild_carpenter',
        name: 'Lonca Marangozu',
        icon: '🪵',
        desc: 'Marangozluk tecrübesiyle okyanusun derinliklerindeki batık hazineleri daha kolay tespit edilir.',
        maxLevel: 5,
        effectPerLevel: 0.5,
        perLevelText: 'Seviye başına: +%0.5 Ölü Denizcinin Hazinesi Düşme İhtimali',
        formatBonus: (lv) => `+%$${(lv * 0.5).toFixed(1)} Hazine Drop İhtimali`
    }
];

let activeGuildTab = 'skills'; // 'skills' veya 'members'

// Aktif lonca verilerini doğrula ve eksik alanları tamamla
if (activeGuild) {
    if (typeof activeGuild.level !== 'number') activeGuild.level = 1;
    if (typeof activeGuild.exp !== 'number') activeGuild.exp = 0;
    if (!activeGuild.skills) {
        activeGuild.skills = {
            guild_blessing: 0,
            guild_alchemist: 0,
            guild_veteran: 0,
            guild_gambler: 0,
            guild_carpenter: 0
        };
    }
    if (typeof activeGuild.skillPoints !== 'number') {
        const spent = Object.values(activeGuild.skills).reduce((a, b) => a + (b || 0), 0);
        activeGuild.skillPoints = Math.max(0, activeGuild.level - spent);
    }
    if (!activeGuild.vault || !Array.isArray(activeGuild.vault)) {
        activeGuild.vault = [new Array(24).fill(null), new Array(24).fill(null)];
    }
}

// Oyuncunun lonca adı varsa ama activeGuild boşsa senkronize et
if (player.guildName && (!activeGuild || !activeGuild.name)) {
    activeGuild = {
        name: player.guildName,
        leader: player.name || 'Oyuncu',
        createdDate: new Date().toLocaleDateString('tr-TR'),
        level: 1,
        exp: 0,
        skillPoints: 1,
        skills: {
            guild_blessing: 0,
            guild_alchemist: 0,
            guild_veteran: 0,
            guild_gambler: 0,
            guild_carpenter: 0
        },
        vault: [new Array(24).fill(null), new Array(24).fill(null)],
        activeVaultPage: 0,
        members: [
            { name: player.name || 'Oyuncu', level: player.level || 1, role: 'Lider', online: true, isPlayer: true },
            { name: 'Kuzeyli Balıkçı', level: 14, role: 'Subay', online: true },
            { name: 'Deniz Gözcüsü Ege', level: 9, role: 'Üye', online: false },
            { name: 'Fırtına Reis', level: 18, role: 'Kıdemli Üye', online: true },
            { name: 'Gümüşkanca', level: 6, role: 'Çırak', online: false }
        ]
    };
    saveGuildData();
}

function saveGuildData() {
    try {
        if (activeGuild) {
            localStorage.setItem('mmo_guild_data', JSON.stringify(activeGuild));
            localStorage.setItem('mmo_player_guild', activeGuild.name);
            player.guildName = activeGuild.name;
        } else {
            localStorage.removeItem('mmo_guild_data');
            localStorage.removeItem('mmo_player_guild');
            player.guildName = '';
        }
    } catch (e) {
        console.warn('Lonca verisi kaydedilemedi:', e);
    }
}

function getGuildSkillLevel(skillId) {
    if (!player.guildName || !activeGuild || !activeGuild.skills) return 0;
    return Number(activeGuild.skills[skillId] || 0);
}

function isPlayerGuildLeader() {
    if (!player.guildName || !activeGuild) return false;
    if (activeGuild.leader && (activeGuild.leader === player.name || activeGuild.leader === 'Oyuncu')) return true;
    const member = (activeGuild.members || []).find(m => m.isPlayer || m.name === player.name);
    return member ? member.role === 'Lider' : false;
}

// Balık Tuttukça Lonca EXP ve Level Sistemi (Maks: 10 Lv)
function gainGuildExp(rarityKeyOrId) {
    if (!player.guildName || !activeGuild) return;
    if ((activeGuild.level || 1) >= 10) {
        activeGuild.level = 10;
        activeGuild.exp = 100;
        saveGuildData();
        return;
    }
    const key = (rarityKeyOrId || '').toLowerCase();
    const expMap = {
        common: 1,     // Sıradan: %1
        uncommon: 2,   // Gelişmiş: %2
        rare: 3,       // Nadir: %3
        epic: 4,       // Destansı: %4
        legendary: 5   // Efsanevi: %5
    };
    const expGain = expMap[key] || 1;
    activeGuild.exp = (activeGuild.exp || 0) + expGain;

    let leveledUp = false;
    while (activeGuild.exp >= 100 && activeGuild.level < 10) {
        activeGuild.level += 1;
        activeGuild.skillPoints = (activeGuild.skillPoints || 0) + 1;
        activeGuild.exp -= 100;
        leveledUp = true;
    }

    if (activeGuild.level >= 10) {
        activeGuild.level = 10;
        activeGuild.exp = 100;
    }

    if (leveledUp) {
        showToast(`🏛️ TEBRİKLER! Loncanız [Lv.${activeGuild.level}] seviyeye ulaştı! (+1 Lonca Yetenek Puanı)`, '#ffd166');
        addChatMessage('Lonca', `🎉 Loncamız Seviye ${activeGuild.level} oldu! 1 Yetenek Puanı kazanıldı. [G] penceresinden yetenekleri geliştirebilirsiniz.`, 'system');
        const gModal = document.getElementById('guild-modal');
        if (gModal && !gModal.classList.contains('hidden')) {
            renderGuildWindow();
        }
    }

    saveGuildData();
}

function createGuild(rawName) {
    const name = (rawName || '').trim();
    if (!name || name.length < 3 || name.length > 18) {
        showToast('⚠️ Lonca ismi 3 ile 18 karakter arasında olmalıdır!', '#ff595e');
        return false;
    }
    player.guildName = name;
    activeGuild = {
        name: name,
        leader: player.name || 'Oyuncu',
        createdDate: new Date().toLocaleDateString('tr-TR'),
        level: 1,
        exp: 0,
        skillPoints: 1,
        skills: {
            guild_blessing: 0,
            guild_alchemist: 0,
            guild_veteran: 0,
            guild_gambler: 0,
            guild_carpenter: 0
        },
        vault: [new Array(24).fill(null), new Array(24).fill(null)],
        activeVaultPage: 0,
        members: [
            { name: player.name || 'Oyuncu', level: player.level || 1, role: 'Lider', online: true, isPlayer: true },
            { name: 'Kuzeyli Balıkçı', level: 14, role: 'Subay', online: true },
            { name: 'Deniz Gözcüsü Ege', level: 9, role: 'Üye', online: false },
            { name: 'Fırtına Reis', level: 18, role: 'Kıdemli Üye', online: true },
            { name: 'Gümüşkanca', level: 6, role: 'Çırak', online: false }
        ]
    };
    saveGuildData();
    showToast(`🏛️ "${name}" loncası başarıyla kuruldu!`, '#ffd166');
    addChatMessage('Lonca', `Tebrikler! "${name}" loncasını kurdun. Artık bir Lonca Liderisin!`, 'system');
    return true;
}

function leaveGuild() {
    if (!player.guildName) return;
    const oldName = player.guildName;
    if (confirm(`"${oldName}" loncasından ayrılmak istediğine emin misin?`)) {
        player.guildName = '';
        activeGuild = null;
        saveGuildData();
        showToast(`🚪 "${oldName}" loncasından ayrıldın.`, '#adb5bd');
        addChatMessage('Lonca', `"${oldName}" loncasından ayrıldın.`, 'system');
        const npcModal = document.getElementById('npc-modal');
        if (npcModal && !npcModal.classList.contains('hidden')) {
            npcModal.classList.add('hidden');
        }
        const guildModal = document.getElementById('guild-modal');
        if (guildModal && !guildModal.classList.contains('hidden')) {
            renderGuildWindow();
        }
    }
}

// Lonca Lideri NPC Modal Görünümü
function renderGuildNPCModal(container) {
    if (!player.guildName || !activeGuild) {
        // Lonca Kurma Ekranı
        container.innerHTML = `
            <div class="guild-unregistered-box" style="margin-bottom: 0;">
                <div class="guild-crest-big">🏛️</div>
                <h3>Dörtyol Lonca Karargâhı</h3>
                <p>Dörtyol'un kalbinde kendi loncanı kur! Dostlarını bir araya topla, balık tuttukça seviye atlayarak ortak yetenekleri aç, 48 slotluk devasa kasayı kullan ve adının hemen üstünde parlayan koyu sarı unvanla tanın.</p>
                
                <div style="max-width: 440px; margin: 0 auto 20px auto; display: flex; flex-direction: column; gap: 10px;">
                    <input type="text" id="npc-guild-create-input" class="char-name-input" placeholder="Lonca Adını Yazın (3-18 Harf)" maxlength="18" style="text-align: center; font-size: 15px; font-weight: 700; color: #ffd166;" />
                    <button class="primary-btn" id="npc-guild-create-btn" style="padding: 12px; font-size: 15px; font-weight: 800; background: linear-gradient(135deg, #e5a93c, #b37400); color: #000; border: none; box-shadow: 0 4px 15px rgba(229,169,60,0.4);">
                        🏛️ Lonca Oluştur
                    </button>
                </div>

                <div class="guild-perks-list">
                    <div class="guild-perk-item">👑 Kafanızın hemen üzerinde <b>Koyu Sarı</b> lonca unvanı</div>
                    <div class="guild-perk-item">🌟 <b>1-10 Seviye & Yetenek Ağacı</b>: Balık tuttukça EXP kazanıp ortak pasifleri güçlendir</div>
                    <div class="guild-perk-item">🏦 <b>48 Slottan</b> oluşan ortak Lonca Kasası (Banka)</div>
                    <div class="guild-perk-item">👥 <b>[G]</b> tuşu ile yetenek paneli, üye listesi ve çevrimiçi durumu takibi</div>
                </div>
            </div>
        `;

        const inputEl = document.getElementById('npc-guild-create-input');
        const createBtn = document.getElementById('npc-guild-create-btn');
        if (inputEl) {
            inputEl.focus();
            inputEl.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    if (createGuild(inputEl.value)) {
                        renderGuildNPCModal(container);
                    }
                }
            };
        }
        if (createBtn) {
            createBtn.onclick = () => {
                if (inputEl && createGuild(inputEl.value)) {
                    renderGuildNPCModal(container);
                }
            };
        }
    } else {
        // Lonca Üyesi / Lideri Ekranı: 2 Seçenek (Lonca Kasası & Lonca'dan Ayrıl)
        if (activeGuild.members && activeGuild.members.length > 0) {
            const leaderMember = activeGuild.members.find(m => m.isPlayer || m.role === 'Lider');
            if (leaderMember) {
                leaderMember.name = player.name || 'Oyuncu';
                leaderMember.level = player.level || 1;
            }
        }

        const isMaxLv = (activeGuild.level || 1) >= 10;

        container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <div class="guild-banner-card" style="margin: 0;">
                    <div class="guild-banner-left">
                        <div class="guild-crest-icon">🏛️</div>
                        <div>
                            <div class="guild-name-title">⟨ ${activeGuild.name} ⟩</div>
                            <div class="guild-meta-sub">
                                <span>👑 Lider: <b>${activeGuild.leader}</b></span>
                                <span>📅 Kuruluş: <b>${activeGuild.createdDate || 'Yeni'}</b></span>
                            </div>
                        </div>
                    </div>
                    <div class="guild-stats-strip">
                        <div class="guild-stat-pill">Seviye: <b>Lv. ${activeGuild.level || 1} / 10</b></div>
                        <div class="guild-stat-pill">EXP: <b>${isMaxLv ? 'MAKS' : `%${activeGuild.exp || 0}`}</b></div>
                        <div class="guild-stat-pill">🌟 Puan: <b>${activeGuild.skillPoints || 0}</b></div>
                        <div class="guild-stat-pill">Kasa: <b>48 Slot</b></div>
                    </div>
                </div>

                <!-- KRAKEN SEFERİ KARTI -->
                <div id="guild-kraken-raid-wrap"></div>

                <div style="background: rgba(14, 20, 32, 0.7); border: 1px solid rgba(200, 155, 110, 0.25); border-radius: 12px; padding: 20px; text-align: center;">
                    <h4 style="color: #ffd166; margin-bottom: 6px; font-size: 16px;">Selamlar, ${player.name || 'Kahraman'}!</h4>
                    <p style="color: #adb5bd; font-size: 13px; margin-bottom: 18px;">Lonca hazinene eşya aktarabilir veya loncadan ayrılabilirsin.</p>
                    
                    <div style="display: flex; gap: 14px; justify-content: center; flex-wrap: wrap;">
                        <button class="primary-btn" id="guild-npc-storage-btn" style="flex: 1; min-width: 220px; padding: 14px 20px; font-size: 15px; font-weight: 800; background: linear-gradient(135deg, #7209b7, #560bad); border: 1.5px solid #ffd166; box-shadow: 0 4px 15px rgba(114,9,183,0.35);">
                            🏦 Lonca Kasası (48 Slot)
                        </button>
                        <button class="secondary-btn" id="guild-npc-leave-btn" style="flex: 1; min-width: 170px; padding: 14px 20px; font-size: 14px; font-weight: 700; color: #ff595e; border: 1.5px solid rgba(239, 35, 60, 0.5); background: rgba(239, 35, 60, 0.15);">
                            🚪 Lonca'dan Ayrıl
                        </button>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(11, 15, 23, 0.5); border-radius: 8px; padding: 10px 14px;">
                    <span style="font-size: 12px; color: #adb5bd;">💡 Lonca yetenek ağacını ve üyeleri görmek için [G] tuşuna basabilirsin.</span>
                    <button class="secondary-btn" id="guild-npc-roster-btn" style="font-size: 12px; padding: 6px 14px;">🌟 Yetenekler & Üyeler [G]</button>
                </div>
            </div>
        `;

        // Kraken Seferi Arayüzü & Buton Bağlantıları
        const raidWrap = document.getElementById('guild-kraken-raid-wrap');
        if (raidWrap) {
            const isLeader = isPlayerGuildLeader();
            const hasDest = Boolean(activeGuild && activeGuild.hasDestroyer);
            const isRaidActive = Boolean(activeGuild && activeGuild.krakenActive);
            const evStatus = getKrakenEventStatus();

            if (!hasDest) {
                raidWrap.innerHTML = `
                    <div style="background: rgba(185, 28, 28, 0.12); border: 1.5px dashed rgba(239, 68, 68, 0.5); border-radius: 10px; padding: 14px; text-align: left;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <strong style="color: #f87171; font-size: 14px;">🦑 Kraken Seferi (Kızıl Okyanus) [KİLİTLİ]</strong>
                            <span style="font-size: 11px; background: rgba(239, 68, 68, 0.2); color: #fca5a5; padding: 2px 8px; border-radius: 4px; font-weight:700;">Gemi Gerekir</span>
                        </div>
                        <p style="font-size: 12px; color: #cbd5e1; margin: 6px 0 0 0; line-height: 1.4;">
                            Bu efsanevi bölgeye sefer başlatabilmek için Lonca Liderinin, <b>Lonca Muhafızından</b> 5 İnci karşılığında <b>Lonca Destroyer'i</b> satın almış olması gerekir.
                        </p>
                    </div>
                `;
            } else if (!evStatus.isActive) {
                raidWrap.innerHTML = `
                    <div style="background: rgba(185, 28, 28, 0.12); border: 1.5px dashed rgba(239, 68, 68, 0.6); border-radius: 10px; padding: 14px; text-align: left;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <strong style="color: #f87171; font-size: 14px;">⏰ KRAKEN ZAMANI KAPALI</strong>
                            <span style="font-size: 11px; background: rgba(239, 68, 68, 0.25); color: #fca5a5; padding: 2px 8px; border-radius: 4px; font-weight:700;">Etkinlik Bekleniyor</span>
                        </div>
                        <p style="font-size: 12px; color: #cbd5e1; margin: 6px 0 8px 0; line-height: 1.45;">
                            Kızıl Okyanus'a açılabilmek için <b>Kraken Zamanı</b> sefer saatinin gelmesi gerekir. Bu saatler dışında deniz canavarları derin uykudadır.
                        </p>
                        <div style="background: rgba(0,0,0,0.3); border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #ffd166; display:flex; justify-content:space-between; align-items:center;">
                            <span>⏳ Bir Sonraki Sefer:</span>
                            <b>${evStatus.nextStartFormatted || 'Belirtilmedi'}</b>
                        </div>
                        <button class="action-btn" disabled style="width: 100%; margin-top: 10px; padding: 9px; opacity: 0.55; cursor: not-allowed; background: #374151; color: #9ca3af; font-weight: 700;">
                            🚫 Kraken Zamanı Bekleniyor
                        </button>
                    </div>
                `;
            } else if (isLeader) {
                raidWrap.innerHTML = `
                    <div style="background: linear-gradient(135deg, rgba(60, 10, 20, 0.85) 0%, rgba(20, 5, 8, 0.95) 100%); border: 1.5px solid #ef4444; border-radius: 10px; padding: 14px; text-align: left; box-shadow: 0 4px 16px rgba(220,38,38,0.35);">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <strong style="color: #ffd166; font-size: 15px;">🦑 Kraken Seferi (Lonca Destroyer'i Hazır)</strong>
                            <span style="font-size: 11px; background: #10b981; color: #000; padding: 2px 8px; border-radius: 4px; font-weight: 800;">🔥 ZAMAN AKTİF (${evStatus.timeRemainingFormatted || 'Sınırsız'})</span>
                        </div>
                        <p style="font-size: 12px; color: #e2e8f0; margin: 6px 0 10px 0; line-height: 1.4;">
                            Kraken Zamanı başladı! Sefere çıktığında Kraken haritasında Destroyer ile spawn olacaksın. Tüm lonca üyeleri teknene ışınlanabilecek ve aynı güvertede birlikte olta atabileceksiniz. Tekne kontrolü sendedir.
                        </p>
                        <button class="primary-btn" id="guild-launch-kraken-btn" style="width: 100%; padding: 10px; font-size: 14px; font-weight: 800; background: linear-gradient(135deg, #dc2626, #991b1b); color: #fff; border: 1.5px solid #ffd166; box-shadow: 0 4px 14px rgba(220,38,38,0.5);">
                            ⚓ Kraken'e Işınlan (Lonca Destroyer'i ile Sefer Başlat)
                        </button>
                    </div>
                `;
                const lBtn = document.getElementById('guild-launch-kraken-btn');
                if (lBtn) {
                    lBtn.onclick = () => {
                        activeGuild.krakenActive = true;
                        saveGuildData();
                        currentMapId = 'kraken';
                        player.x = 13.5;
                        player.y = 13.5;
                        player.path = [];
                        document.getElementById('npc-modal').classList.add('hidden');
                        addChatMessage('Lonca', `🚨 Lonca Lideri [${player.name}] Lonca Destroyer'i ile Kızıl Okyanus Kraken seferini başlattı! Tüm üyeler Karargâhtan tekneye ışınlanabilir!`, 'system');
                        showToast("🦑 Kızıl Okyanus'a varıldı! Lonca Destroyer'i emrinde.", '#ffd166');
                    };
                }
            } else {
                if (isRaidActive) {
                    raidWrap.innerHTML = `
                        <div style="background: linear-gradient(135deg, rgba(20, 40, 60, 0.85) 0%, rgba(10, 20, 35, 0.95) 100%); border: 1.5px solid #00f5d4; border-radius: 10px; padding: 14px; text-align: left; box-shadow: 0 4px 16px rgba(0,245,212,0.35);">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <strong style="color: #00f5d4; font-size: 15px;">🦑 KRAKEN SEFERİ AKTİF!</strong>
                                <span style="font-size: 11px; background: #00f5d4; color: #000; padding: 2px 8px; border-radius: 4px; font-weight: 800;">SEFERDE (${evStatus.timeRemainingFormatted || 'Sınırsız'})</span>
                            </div>
                            <p style="font-size: 12px; color: #e2e8f0; margin: 6px 0 10px 0; line-height: 1.4;">
                                Lonca Lideri şu anda Kızıl Okyanus'ta Destroyer ile seyirde! Hemen tekneye katılıp güverteden olta atabilirsin.
                            </p>
                            <button class="primary-btn" id="guild-join-kraken-btn" style="width: 100%; padding: 10px; font-size: 14px; font-weight: 800; background: linear-gradient(135deg, #00b4d8, #0077b6); color: #fff; border: 1.5px solid #00f5d4; box-shadow: 0 4px 14px rgba(0,180,216,0.5);">
                                ⛵ Kraken'e Işınlan (Destroyer'daki Lidere Katıl)
                            </button>
                        </div>
                    `;
                    const jBtn = document.getElementById('guild-join-kraken-btn');
                    if (jBtn) {
                        jBtn.onclick = () => {
                            currentMapId = 'kraken';
                            player.x = 13.5;
                            player.y = 13.5;
                            player.path = [];
                            document.getElementById('npc-modal').classList.add('hidden');
                            showToast("⚓ Lonca Destroyer'ine katıldın! Lider ve lonca üyelerinle birliktesin.", '#4cc9f0');
                            addChatMessage('Lonca', `[${player.name}] Lonca Destroyer'ine katıldı.`, 'system');
                        };
                    }
                } else {
                    raidWrap.innerHTML = `
                        <div style="background: rgba(22, 30, 46, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; padding: 14px; text-align: left;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <strong style="color: #ffd166; font-size: 13.5px;">🦑 Kraken Seferi (Lonca Destroyer'i Hazır)</strong>
                                <span style="font-size: 11px; background: rgba(46,196,182,0.2); color: #2ec4b6; padding: 2px 8px; border-radius: 4px; font-weight:700;">Zaman Aktif</span>
                            </div>
                            <p style="font-size: 12px; color: #94a3b8; margin: 4px 0 0 0;">
                                Lonca Destroyer'i hazır ve Kraken Zamanı başladı. Lonca Lideri sefere çıktığında buradan doğrudan tekneye ışınlanabileceksin.
                            </p>
                        </div>
                    `;
                }
            }
        }

        document.getElementById('guild-npc-storage-btn').onclick = () => {
            renderGuildStorageModal(container);
        };
        document.getElementById('guild-npc-leave-btn').onclick = () => {
            leaveGuild();
        };
        document.getElementById('guild-npc-roster-btn').onclick = () => {
            document.getElementById('npc-modal').classList.add('hidden');
            toggleGuildWindow();
        };
    }
}

// Lonca Muhafızı NPC Modal Görünümü (Lonca Cephaneliği & Eşyaları)
function renderGuildGuardModal(container) {
    const isGuildMember = Boolean(player.guildName && activeGuild);
    const guildName = isGuildMember ? activeGuild.name : 'Henüz Loncada Değilsin';
    const guildLv = isGuildMember ? `Lv. ${activeGuild.level || 1} / 10` : '-';

    container.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:16px;">
            <div class="guild-banner-card" style="margin:0; border-color:#4cc9f0; background:linear-gradient(135deg, rgba(20, 32, 60, 0.9) 0%, rgba(14, 18, 30, 0.95) 100%);">
                <div class="guild-banner-left">
                    <div class="guild-crest-icon" style="border-color:#4cc9f0; background:rgba(76,201,240,0.15);">🛡️</div>
                    <div>
                        <div class="guild-name-title" style="color:#4cc9f0;">Lonca Cephaneliği & Muhafız Tezgâhı</div>
                        <div class="guild-meta-sub">
                            <span>🏛️ Loncan: <b style="color:#ffd166;">${guildName}</b> (${guildLv})</span>
                        </div>
                    </div>
                </div>
                <div class="guild-stats-strip">
                    <div class="guild-stat-pill" style="border-color:rgba(76,201,240,0.4);">Durum: <b style="color:#4cc9f0;">Muhafız Nöbette</b></div>
                </div>
            </div>

            <div style="background:rgba(14, 20, 32, 0.7); border:1px solid rgba(76, 201, 240, 0.25); border-radius:12px; padding:18px;">
                <p style="color:#ced4da; font-size:13.5px; line-height:1.6; margin:0 0 16px;">
                    <i>"Selamlar cesur balıkçı! Ben Lonca Karargâhı'nın Muhafızıyım. Burada yakında lonca üyelerine özel sancaklar, güçlendirici iksirler, lonca zırhları ve özel efsunlu oltalar satışa sunulacak. Loncanı balık tutarak <b>10. Seviyeye</b> kadar geliştir ve lonca yeteneklerini hazır tut!"</i>
                </p>

                <!-- LONCA DESTROYER'İ (KRAKEN SEFER GEMİSİ) -->
                <div style="background: linear-gradient(135deg, rgba(30, 10, 16, 0.95) 0%, rgba(18, 5, 8, 0.98) 100%); border: 1.5px solid #ef4444; border-radius: 10px; padding: 14px; margin-bottom: 14px; box-shadow: 0 4px 18px rgba(220,38,38,0.35);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-size:28px;">🚢</span>
                            <div>
                                <div style="font-weight:800; color:#ffd166; font-size:15px;">Lonca Destroyer'i (Zırhlı Savaş Gemisi)</div>
                                <div style="font-size:11.5px; color:#fca5a5;">Kraken Haritası Sefer Gemisi • Tüm Mürettebatı Taşır</div>
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <span style="font-size:14px; font-weight:800; color:#90e0ef;">🦪 5 Adet İnci</span>
                        </div>
                    </div>
                    <p style="font-size:12px; color:#e2e8f0; line-height:1.5; margin:0 0 12px 0;">
                        Kraken Haritası'na (Kızıl Okyanus) yelken açmak için gereken heybetli lonca savaş gemisidir. Bir kez satın alındığında kalıcı olarak loncaya eklenir. Lonca Lideri bu gemiyle sefere çıktığında tüm lonca üyeleri gemiye ışınlanabilir ve hep birlikte devasa güverteden olta atabilir!
                    </p>
                    <div id="guard-destroyer-action-wrap"></div>
                </div>

                <div style="font-weight:700; color:#ffd166; font-size:13px; margin-bottom:10px;">📦 Hazırlanan Özel Lonca Eşyaları (Pek Yakında):</div>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap:10px;">
                    <div style="background:rgba(22, 30, 46, 0.85); border:1px dashed rgba(76, 201, 240, 0.4); border-radius:8px; padding:12px; display:flex; align-items:center; gap:10px;">
                        <span style="font-size:26px;">🚩</span>
                        <div>
                            <div style="font-weight:700; color:#4cc9f0; font-size:13px;">Lonca Savaş Sancağı</div>
                            <div style="font-size:11.5px; color:#adb5bd;">Tüm üyeler için +%10 EXP aurası</div>
                            <div style="font-size:11px; color:#ffbe0b; font-weight:700; margin-top:2px;">[Pek Yakında]</div>
                        </div>
                    </div>
                    <div style="background:rgba(22, 30, 46, 0.85); border:1px dashed rgba(76, 201, 240, 0.4); border-radius:8px; padding:12px; display:flex; align-items:center; gap:10px;">
                        <span style="font-size:26px;">🧪</span>
                        <div>
                            <div style="font-weight:700; color:#80ed99; font-size:13px;">Kadim Bereket İksiri</div>
                            <div style="font-size:11.5px; color:#adb5bd;">Nadir balık şansını 30 dk 2x yapar</div>
                            <div style="font-size:11px; color:#ffbe0b; font-weight:700; margin-top:2px;">[Pek Yakında]</div>
                        </div>
                    </div>
                    <div style="background:rgba(22, 30, 46, 0.85); border:1px dashed rgba(76, 201, 240, 0.4); border-radius:8px; padding:12px; display:flex; align-items:center; gap:10px;">
                        <span style="font-size:26px;">⚓</span>
                        <div>
                            <div style="font-weight:700; color:#ffd166; font-size:13px;">Muhafız Çapası</div>
                            <div style="font-size:11.5px; color:#adb5bd;">Akdeniz dalgalarında sabitlenme</div>
                            <div style="font-size:11px; color:#ffbe0b; font-weight:700; margin-top:2px;">[Pek Yakında]</div>
                        </div>
                    </div>
                    <div style="background:rgba(22, 30, 46, 0.85); border:1px dashed rgba(76, 201, 240, 0.4); border-radius:8px; padding:12px; display:flex; align-items:center; gap:10px;">
                        <span style="font-size:26px;">👑</span>
                        <div>
                            <div style="font-weight:700; color:#c77dff; font-size:13px;">Liderlik Tacı</div>
                            <div style="font-size:11.5px; color:#adb5bd;">Lonca üyelerine kafa üstü parıltı</div>
                            <div style="font-size:11px; color:#ffbe0b; font-weight:700; margin-top:2px;">[Pek Yakında]</div>
                        </div>
                    </div>
                </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:12px; color:#adb5bd;">💡 Eşyalar eklendiğinde Lonca Seviyesi ve Lonca Kasası üzerinden temin edilecektir.</span>
                <button class="secondary-btn" id="guild-guard-open-guild-btn" style="padding:8px 16px;">🏛️ Lonca Penceresini Aç [G]</button>
            </div>
        </div>
    `;

    // Lonca Destroyer'i Buton Durumu & Satın Alma
    const actWrap = document.getElementById('guard-destroyer-action-wrap');
    if (actWrap) {
        const isLeader = isPlayerGuildLeader();
        const hasDest = Boolean(activeGuild && activeGuild.hasDestroyer);
        const pearls = getItemCountInInventory('item_pearl');

        if (hasDest) {
            actWrap.innerHTML = `
                <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(46,196,182,0.2); border:1px solid #2ec4b6; color:#2ec4b6; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:800;">
                    ✅ Loncaya Ait (Satın Alındı • Karargâhta Sefer İçin Hazır)
                </div>
            `;
        } else if (!isLeader) {
            actWrap.innerHTML = `
                <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:700;">
                    🔒 Yalnızca Lonca Lideri satın alabilir (Envanterinde 5 İnci olmalıdır)
                </div>
            `;
        } else {
            const canBuy = pearls >= 5;
            actWrap.innerHTML = `
                <div style="display:flex; align-items:center; gap:12px;">
                    <button class="primary-btn" id="btn-buy-guild-destroyer" ${!canBuy ? 'disabled' : ''} style="padding:9px 18px; font-size:13px; font-weight:800; background:linear-gradient(135deg, #e63946, #b7094c); border:1px solid #ffd166;">
                        ${canBuy ? '🛒 5 İnci Karşılığı Satın Al' : `⚠️ 5 İnci Gerekir (Sende: ${pearls}/5)`}
                    </button>
                    <span style="font-size:11.5px; color:#adb5bd;">Envanterindeki İnci: <b style="color:#90e0ef;">${pearls}</b> Adet</span>
                </div>
            `;

            const buyBtn = document.getElementById('btn-buy-guild-destroyer');
            if (buyBtn && canBuy) {
                buyBtn.onclick = () => {
                    if (removeMultipleFromInventory('item_pearl', 5)) {
                        activeGuild.hasDestroyer = true;
                        saveGuildData();
                        updateExpHUD();
                        renderInventoryUI();
                        showToast("🚢 TEBRİKLER! Lonca Destroyer'i satın alındı! Lonca Lideri artık Karargâhtan Kraken Seferini başlatabilir.", '#ffd166');
                        addChatMessage('Lonca', `🎉 Loncamız için [Lonca Destroyer'i] 5 İnci ile satın alındı! Lider artık Karargâhtan Kraken Seferi başlatabilir.`, 'system');
                        renderGuildGuardModal(container);
                    } else {
                        showToast('⚠️ İnci çantandan düşülemedi!', '#ff595e');
                    }
                };
            }
        }
    }

    const gBtn = document.getElementById('guild-guard-open-guild-btn');
    if (gBtn) {
        gBtn.onclick = () => {
            document.getElementById('npc-modal').classList.add('hidden');
            toggleGuildWindow();
        };
    }
}

// 48 Slotluk Lonca Kasası (Banka)
function renderGuildStorageModal(container) {
    if (!activeGuild) {
        renderGuildNPCModal(container);
        return;
    }
    if (!activeGuild.vault || !Array.isArray(activeGuild.vault) || activeGuild.vault.length !== 2) {
        activeGuild.vault = [new Array(24).fill(null), new Array(24).fill(null)];
    }
    if (activeGuild.activeVaultPage === undefined) {
        activeGuild.activeVaultPage = 0;
    }

    const pageIdx = activeGuild.activeVaultPage;
    const vaultPage = activeGuild.vault[pageIdx];

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🏛️ Lonca Kasası (Sayfa ${pageIdx + 1} / 2 - 48 Slot Banka)</h3>
                    <div class="tab-group">
                        <button class="tab-btn ${pageIdx === 0 ? 'active' : ''}" id="g-st-page-0">1. Sayfa (1-24)</button>
                        <button class="tab-btn ${pageIdx === 1 ? 'active' : ''}" id="g-st-page-1">2. Sayfa (25-48)</button>
                    </div>
                </div>
                <div class="slot-grid" id="guild-storage-vault-grid"></div>
                <div class="bag-subhint">Kasadan çantana almak istediğin eşyaya tıkla.</div>
            </div>
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🎒 Çantan (${player.inventory.length} / 24)</h3>
                </div>
                <div class="slot-grid" id="guild-storage-bag-grid"></div>
                <div class="bag-subhint">Kasaya yatırmak istediğin eşyaya tıkla.</div>
            </div>
        </div>
        <div style="margin-top: 14px; display: flex; justify-content: space-between; align-items: center;">
            <button class="secondary-btn" id="guild-storage-back-btn">⬅️ Lonca Menüsüne Dön</button>
            <div style="font-size: 12px; color: #adb5bd;">🏛️ <b>${activeGuild.name}</b> Lonca Kasası (48 Slotluk Banka)</div>
        </div>
    `;

    document.getElementById('g-st-page-0').onclick = () => {
        activeGuild.activeVaultPage = 0;
        renderGuildStorageModal(container);
    };
    document.getElementById('g-st-page-1').onclick = () => {
        activeGuild.activeVaultPage = 1;
        renderGuildStorageModal(container);
    };
    document.getElementById('guild-storage-back-btn').onclick = () => {
        renderGuildNPCModal(container);
    };

    sanitizeVaultAndInventoryCostumes();

    // Kasa Gridini Doldur (24 Slot bu sayfada)
    const vaultGrid = document.getElementById('guild-storage-vault-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';
        const entry = vaultPage[i];
        if (entry && ITEMS[entry.id]) {
            const item = ITEMS[entry.id];
            const wrap = document.createElement('div');
            wrap.className = 'slot-item-icon';
            wrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(wrap);
            if (entry.count > 1) {
                const c = document.createElement('span');
                c.className = 'item-count';
                c.textContent = `x${entry.count}`;
                slotDiv.appendChild(c);
            }
            if ((item.type === 'rod' || item.type === 'costume') && entry.enchants && entry.enchants.count > 0) {
                const eb = document.createElement('span');
                eb.className = 'enchant-badge';
                eb.textContent = `+${entry.enchants.count}`;
                slotDiv.appendChild(eb);
            }
            if (item.isRoyal || item.isSOS) {
                slotDiv.classList.add('sos-slot');
            }
            const e = (item.type === 'rod' || item.type === 'costume') ? (entry.enchants || getEntryEnchants(entry)) : null;
            const plusStr = e && e.count > 0 ? ` (+${e.count})` : '';
            slotDiv.title = `${item.name}${plusStr} (Çantaya çekmek için tıkla)`;
            slotDiv.onclick = () => {
                if (addItemToInventory(entry.id, entry.count, entry.enchants || null)) {
                    vaultPage[i] = null;
                    saveGuildData();
                    renderGuildStorageModal(container);
                } else {
                    showToast('⚠️ Çantan dolu!', '#ff595e');
                }
            };
        }
        vaultGrid.appendChild(slotDiv);
    }

    // Çanta Gridini Doldur (24 Slot)
    const bagGrid = document.getElementById('guild-storage-bag-grid');
    for (let i = 0; i < 24; i++) {
        const slotDiv = document.createElement('div');
        slotDiv.className = 'item-slot';
        const entry = player.inventory[i];
        if (entry && ITEMS[entry.id]) {
            const item = ITEMS[entry.id];
            const wrap = document.createElement('div');
            wrap.className = 'slot-item-icon';
            wrap.appendChild(createItemIconCanvas(item));
            slotDiv.appendChild(wrap);
            if (entry.count > 1) {
                const c = document.createElement('span');
                c.className = 'item-count';
                c.textContent = `x${entry.count}`;
                slotDiv.appendChild(c);
            }
            if (item.type === 'rod' || item.type === 'costume') {
                const e = getEntryEnchants(entry);
                if (e && e.count > 0) {
                    const eb = document.createElement('span');
                    eb.className = 'enchant-badge';
                    eb.textContent = `+${e.count}`;
                    slotDiv.appendChild(eb);
                }
            }
            if (item.isRoyal || item.isSOS) {
                slotDiv.classList.add('sos-slot');
            }
            const e = (item.type === 'rod' || item.type === 'costume') ? getEntryEnchants(entry) : null;
            const plusStr = e && e.count > 0 ? ` (+${e.count})` : '';
            slotDiv.title = `${item.name}${plusStr} (Kasaya yatırmak için tıkla)`;
            slotDiv.onclick = () => {
                if (item.type === 'rod' || item.type === 'costume') {
                    const emptySlot = vaultPage.findIndex(s => s === null);
                    if (emptySlot === -1) {
                        showToast('⚠️ Lonca kasasının bu sayfası dolu! Diğer sayfaya geçebilirsin.', '#ff595e');
                        return;
                    }
                    vaultPage[emptySlot] = {
                        id: entry.id,
                        count: 1,
                        uid: entry.uid || generateItemUid(),
                        enchants: { ...getEntryEnchants(entry) }
                    };
                    if (entry.uid) {
                        removeItemByUid(entry.uid);
                    } else {
                        removeItemFromInventory(entry.id, 1);
                    }
                } else {
                    let targetSlot = vaultPage.findIndex(s => s && s.id === entry.id);
                    if (targetSlot !== -1) {
                        vaultPage[targetSlot].count += 1;
                    } else {
                        targetSlot = vaultPage.findIndex(s => s === null);
                        if (targetSlot === -1) {
                            showToast('⚠️ Lonca kasasının bu sayfası dolu! Diğer sayfaya geçebilirsin.', '#ff595e');
                            return;
                        }
                        vaultPage[targetSlot] = { id: entry.id, count: 1 };
                    }
                    removeItemFromInventory(entry.id, 1);
                }
                saveGuildData();
                renderGuildStorageModal(container);
            };
        }
        bagGrid.appendChild(slotDiv);
    }
}

// [G] Tuşu ile Lonca Penceresini Açma / Kapatma
function toggleGuildWindow() {
    const modal = document.getElementById('guild-modal');
    if (!modal) return;
    const isHidden = modal.classList.contains('hidden');
    if (isHidden) {
        document.getElementById('inventory-modal').classList.add('hidden');
        document.getElementById('npc-modal').classList.add('hidden');
        document.getElementById('skill-modal').classList.add('hidden');
        document.getElementById('admin-modal').classList.add('hidden');
        closeChatInput();

        modal.classList.remove('hidden');
        renderGuildWindow();
    } else {
        modal.classList.add('hidden');
    }
}

// Lonca Penceresi İçeriği (G Tuşu Anasayfası: Yetenek Ağacı & Üye Paneli)
function renderGuildWindow() {
    const content = document.getElementById('guild-modal-content');
    if (!content) return;

    if (!player.guildName || !activeGuild) {
        content.innerHTML = `
            <div class="guild-unregistered-box">
                <div class="guild-crest-big">🏛️</div>
                <h3>Henüz Bir Loncaya Üye Değilsin</h3>
                <p>
                    Dörtyol Ana Şehir meydanının kuzeydoğusundaki Lonca Tapınağı'na giderek <b>Lonca Lideri</b> ile konuşabilir ve kendi loncanı kurabilirsin!
                </p>
                <div class="guild-perks-list">
                    <div class="guild-perk-item">👑 Başının hemen üzerinde <b>Koyu Sarı</b> lonca unvanı</div>
                    <div class="guild-perk-item">🌟 <b>1-10 Seviye Yetenek Ağacı</b>: Balık tuttukça EXP kazanıp ortak lonca pasiflerini aç</div>
                    <div class="guild-perk-item">🏦 <b>48 Slotluk</b> devasa ortak Lonca Kasası (Banka)</div>
                    <div class="guild-perk-item">👥 Lonca üyeleri, seviyeleri ve anlık çevrimiçi durumu takibi</div>
                    <div class="guild-perk-item">⚔️ Birlikte balıkçılık, sohbet ve macera ortaklığı</div>
                </div>
            </div>
        `;
        return;
    }

    // Oyuncu bilgilerini üye listesinde güncelle
    if (activeGuild.members && activeGuild.members.length > 0) {
        const selfMember = activeGuild.members.find(m => m.isPlayer || m.role === 'Lider');
        if (selfMember) {
            selfMember.name = player.name || 'Oyuncu';
            selfMember.level = player.level || 1;
        }
    }

    const isLeader = isPlayerGuildLeader();
    const isMaxGuildLv = (activeGuild.level || 1) >= 10;
    const pearlEntry = player.inventory.find(i => i.id === 'item_pearl');
    const pearlCount = pearlEntry ? pearlEntry.count : 0;

    // Yetenek Kartları HTML'i
    const guildSkillsHtml = GUILD_SKILLS.map(sk => {
        const curLv = (activeGuild.skills && activeGuild.skills[sk.id]) || 0;
        const totalBonusText = sk.formatBonus(curLv);

        let pipsHtml = '';
        for (let i = 1; i <= sk.maxLevel; i++) {
            pipsHtml += `<span class="skill-pip ${i <= curLv ? 'filled' : ''}"></span>`;
        }

        const isMax = curLv >= sk.maxLevel;
        const hasPoints = (activeGuild.skillPoints || 0) > 0;
        const canUpgrade = isLeader && !isMax && hasPoints;

        let btnText = '➕ Geliştir (1 Puan)';
        if (isMax) {
            btnText = 'MAKSİMUM (5/5)';
        } else if (!isLeader) {
            btnText = '🔒 Yalnızca Lider';
        } else if (!hasPoints) {
            btnText = '➕ Geliştir (0 Puan)';
        }

        return `
            <div class="skill-card" style="margin-bottom:0;">
                <div class="skill-card-left">
                    <div class="skill-icon-box" style="border-color:#ffd166; background:rgba(229,169,60,0.15);">${sk.icon}</div>
                    <div>
                        <div class="skill-title">${sk.name} <span style="color:#adb5bd; font-size:12px;">(${curLv} / ${sk.maxLevel})</span></div>
                        <div class="skill-desc">${sk.desc}</div>
                        <div class="skill-bonus-text">${sk.perLevelText} • <b style="color:#80ed99;">${totalBonusText}</b></div>
                    </div>
                </div>
                <div class="skill-card-right">
                    <div class="skill-pips">${pipsHtml}</div>
                    <button class="action-btn primary" id="up-gskill-${sk.id}" ${canUpgrade ? '' : 'disabled'} style="${canUpgrade ? 'background:linear-gradient(135deg, #e5a93c, #b37400); color:#000;' : ''}">
                        ${btnText}
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // Üye Tablosu HTML'i
    const memberRows = (activeGuild.members || []).map(m => {
        const isSelf = m.isPlayer || m.name === player.name;
        const statusBadge = m.online
            ? `<span class="badge-online">🟢 Çevrimiçi</span>`
            : `<span class="badge-offline">⚫ Çevrimdışı</span>`;
        const roleClass = m.role === 'Lider' ? 'leader' : (m.role === 'Subay' ? 'officer' : 'member');

        return `
            <tr style="${isSelf ? 'background: rgba(229, 169, 60, 0.08); font-weight: 600;' : ''}">
                <td style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:16px;">${isSelf ? '👤' : (m.online ? '🧑‍🤝‍🧑' : '💤')}</span>
                    <span>${m.name} ${isSelf ? '<span style="color:#ffd166; font-size:11px; font-weight:700;">(Sen)</span>' : ''}</span>
                </td>
                <td><b style="color:#ffd166;">Lv. ${m.level}</b></td>
                <td><span class="role-badge ${roleClass}">${m.role}</span></td>
                <td>${statusBadge}</td>
            </tr>
        `;
    }).join('');

    content.innerHTML = `
        <div class="guild-banner-card">
            <div class="guild-banner-left">
                <div class="guild-crest-icon">🏛️</div>
                <div style="flex:1;">
                    <div class="guild-name-title">⟨ ${activeGuild.name} ⟩</div>
                    <div class="guild-meta-sub">
                        <span>👑 Lider: <b>${activeGuild.leader}</b></span>
                        <span>📅 Kuruluş: <b>${activeGuild.createdDate || 'Yeni'}</b></span>
                    </div>
                    <!-- EXP İlerleme Çubuğu -->
                    <div style="margin-top: 8px; max-width: 280px;">
                        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:3px;">
                            <span style="color:#adb5bd;">Lonca Tecrübesi (EXP):</span>
                            <b style="color:${isMaxGuildLv ? '#80ed99' : '#ffd166'};">${isMaxGuildLv ? 'MAKS DÜZEY (%100)' : `%${activeGuild.exp || 0} / %100`}</b>
                        </div>
                        <div style="width:100%; height:7px; background:rgba(0,0,0,0.6); border-radius:4px; overflow:hidden; border:1px solid rgba(229,169,60,0.35);">
                            <div style="width:${isMaxGuildLv ? 100 : (activeGuild.exp || 0)}%; height:100%; background:linear-gradient(90deg, #e5a93c, #ffd166); border-radius:3px; transition:width 0.3s;"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="guild-stats-strip">
                <div class="guild-stat-pill">Seviye: <b style="color:#ffd166;">Lv. ${activeGuild.level || 1} / 10</b></div>
                <div class="guild-stat-pill">🌟 Puan: <b style="color:#80ed99;">${activeGuild.skillPoints || 0} Puan</b></div>
                <div class="guild-stat-pill">Üye: <b>${activeGuild.members.length} / 30</b></div>
                <div class="guild-stat-pill">Kasa: <b>48 Slot</b></div>
            </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(200, 155, 110, 0.25); padding-bottom:10px; margin-top:-4px;">
            <div class="tab-group">
                <button class="tab-btn ${activeGuildTab === 'skills' ? 'active' : ''}" id="tab-g-skills" style="padding:8px 16px; font-weight:700;">
                    🌟 Lonca Yetenek Ağacı
                </button>
                <button class="tab-btn ${activeGuildTab === 'members' ? 'active' : ''}" id="tab-g-members" style="padding:8px 16px; font-weight:700;">
                    👥 Lonca Üyeleri (${activeGuild.members.length})
                </button>
            </div>
            <div style="font-size:11.5px; color:#adb5bd;">
                🐟 Balık EXP: Sıradan %1 • Gelişmiş %2 • Nadir %3 • Destansı %4 • Efsanevi %5
            </div>
        </div>

        ${activeGuildTab === 'skills' ? `
            <div class="guild-members-wrap" style="padding: 16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
                    <div>
                        <h3 style="margin:0; color:#ffd166; font-size:15px;">🌟 Lonca Pasif Yetenek Ağacı</h3>
                        <div style="font-size:12px; color:#adb5bd; margin-top:2px;">
                            Etkin pasif yeteneklerden tüm üyeler yararlanır. Yalnızca Lonca Lideri puan dağıtabilir ve sıfırlayabilir.
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="background:rgba(14,20,32,0.8); border:1px solid rgba(255,209,102,0.4); border-radius:6px; padding:6px 12px; font-size:12px;">
                            Kullanılabilir Puan: <b style="color:#ffd166; font-size:14px;">${activeGuild.skillPoints || 0}</b>
                        </div>
                        <button class="action-btn danger-btn" id="guild-reset-skills-btn" style="padding:7px 12px; font-size:12px;" ${!isLeader ? 'disabled title="Yalnızca Lonca Lideri sıfırlayabilir"' : ''}>
                            🔄 Yetenekleri Sıfırla (5 İnci)
                        </button>
                    </div>
                </div>

                <div style="display:flex; flex-direction:column; gap:10px;">
                    ${guildSkillsHtml}
                </div>
            </div>
        ` : `
            <div class="guild-members-wrap">
                <div class="guild-table-header">
                    <h3>👥 Lonca Üyeleri & Durum Paneli</h3>
                    <span style="font-size: 12px; color: #adb5bd;">Toplam ${activeGuild.members.length} Üye • ${activeGuild.members.filter(m => m.online).length} Çevrimiçi</span>
                </div>
                <table class="guild-members-table">
                    <thead>
                        <tr>
                            <th>Üye Adı</th>
                            <th>Seviye</th>
                            <th>Rütbe</th>
                            <th>Durum</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${memberRows}
                    </tbody>
                </table>
            </div>
        `}

        <div class="guild-footer-actions">
            <button class="primary-btn" id="guild-open-vault-btn" style="background: linear-gradient(135deg, #7209b7, #560bad); border: 1.5px solid #ffd166;">
                🏦 Lonca Kasasını Aç (48 Slot)
            </button>
            <button class="secondary-btn" id="guild-leave-btn" style="color: #ff595e; border-color: rgba(239, 35, 60, 0.4);">
                🚪 Loncadan Ayrıl
            </button>
        </div>
    `;

    // Sekme Butonları
    const tabSkills = document.getElementById('tab-g-skills');
    const tabMembers = document.getElementById('tab-g-members');
    if (tabSkills) {
        tabSkills.onclick = () => {
            activeGuildTab = 'skills';
            renderGuildWindow();
        };
    }
    if (tabMembers) {
        tabMembers.onclick = () => {
            activeGuildTab = 'members';
            renderGuildWindow();
        };
    }

    // Yetenek Geliştirme Butonları (Yalnızca Lider)
    if (activeGuildTab === 'skills') {
        GUILD_SKILLS.forEach(sk => {
            const upBtn = document.getElementById(`up-gskill-${sk.id}`);
            if (upBtn) {
                upBtn.onclick = () => {
                    if (!isLeader) {
                        showToast('⚠️ Yalnızca Lonca Lideri yetenek puanı dağıtabilir!', '#ff595e');
                        return;
                    }
                    if ((activeGuild.skillPoints || 0) <= 0) {
                        showToast('⚠️ Kullanılabilir Lonca Yetenek Puanın yok! Balık tutarak loncana seviye atlat.', '#ff595e');
                        return;
                    }
                    const curLv = (activeGuild.skills && activeGuild.skills[sk.id]) || 0;
                    if (curLv >= sk.maxLevel) {
                        showToast('⚠️ Bu yetenek zaten maksimum seviyede (5/5)!', '#ffbe0b');
                        return;
                    }

                    activeGuild.skillPoints -= 1;
                    activeGuild.skills[sk.id] = curLv + 1;
                    saveGuildData();
                    renderGuildWindow();
                    showToast(`✨ [${sk.name}] Lv.${curLv + 1} seviyesine yükseltildi! Tüm lonca üyeleri bonusu kazandı.`, '#80ed99');
                    addChatMessage('Lonca', `Lonca lideri [${sk.name}] yeteneğini Lv.${curLv + 1} seviyesine yükseltti!`, 'system');
                };
            }
        });

        // Lonca Yeteneklerini Sıfırla (5 İnci Gerekir)
        const resetBtn = document.getElementById('guild-reset-skills-btn');
        if (resetBtn && isLeader) {
            resetBtn.onclick = () => {
                const totalSpent = Object.values(activeGuild.skills || {}).reduce((a, b) => a + (b || 0), 0);
                if (totalSpent === 0) {
                    showToast('Sıfırlanacak harcanmış yetenek puanı bulunmuyor.', '#adb5bd');
                    return;
                }
                const pEntry = player.inventory.find(i => i.id === 'item_pearl');
                const pCount = pEntry ? pEntry.count : 0;
                if (pCount < 5) {
                    showToast(`⚠️ Lonca yeteneklerini sıfırlamak için envanterinde 5 adet [İnci] olmalıdır! (Şu an: ${pCount} / 5)`, '#ff595e');
                    return;
                }
                if (!confirm(`Lonca yetenek ağacını sıfırlamak için 5 adet İnci harcanacak ve harcanan ${totalSpent} yetenek puanı iade edilecek. Onaylıyor musun?`)) {
                    return;
                }

                removeItemFromInventory('item_pearl', 5);
                GUILD_SKILLS.forEach(s => {
                    activeGuild.skills[s.id] = 0;
                });
                activeGuild.skillPoints = (activeGuild.skillPoints || 0) + totalSpent;
                saveGuildData();
                renderGuildWindow();
                showToast(`🔄 Lonca yetenekleri sıfırlandı! 5 İnci harcandı ve ${totalSpent} puan iade edildi.`, '#4cc9f0');
                addChatMessage('Lonca', 'Lonca yetenek ağacı lider tarafından sıfırlandı ve tüm puanlar iade edildi.', 'system');
            };
        }
    }

    document.getElementById('guild-open-vault-btn').onclick = () => {
        document.getElementById('guild-modal').classList.add('hidden');
        const npcModal = document.getElementById('npc-modal');
        const iconEl = document.getElementById('npc-modal-icon');
        const titleEl = document.getElementById('npc-modal-title');
        const subEl = document.getElementById('npc-modal-subtitle');
        const contentEl = document.getElementById('npc-modal-content');
        
        npcModal.classList.remove('hidden');
        iconEl.textContent = '🏛️';
        titleEl.textContent = 'Lonca Kasası (Banka)';
        subEl.textContent = `${activeGuild.name} - 48 Slot Ortak Hazine`;
        renderGuildStorageModal(contentEl);
    };

    document.getElementById('guild-leave-btn').onclick = () => {
        leaveGuild();
    };
}

// ============================================================================
// 9.4 WIKI VE DETAYLI OYUN ANSİKLOPEDİSİ (Z TUŞU)
// ============================================================================
let activeWikiTab = 'basics';

function toggleWikiModal() {
    const modal = document.getElementById('wiki-modal');
    if (!modal) return;
    
    if (modal.classList.contains('hidden')) {
        document.getElementById('inventory-modal')?.classList.add('hidden');
        document.getElementById('skill-modal')?.classList.add('hidden');
        document.getElementById('admin-modal')?.classList.add('hidden');
        document.getElementById('guild-modal')?.classList.add('hidden');
        modal.classList.remove('hidden');
        renderWikiTab(activeWikiTab);
    } else {
        modal.classList.add('hidden');
    }
}

function renderWikiTab(tabKey) {
    activeWikiTab = tabKey;
    const contentEl = document.getElementById('wiki-content');
    if (!contentEl) return;

    document.querySelectorAll('.wiki-nav-btn').forEach(btn => {
        if (btn.getAttribute('data-wikitab') === tabKey) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    let html = '';

    if (tabKey === 'basics') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">🧭 Burnaz Sahil'e Hoş Geldin!</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; line-height: 1.6; color: #e2e8f0;">
                        Bu oyun; retro 2.5D izometrik perspektife sahip, gerçek zamanlı balıkçılık, zanaat, lonca sistemi, şehir ekonomisi ve açık deniz keşiflerini bir araya getiren zengin bir MMO deneyimidir.
                    </p>
                    <p style="margin: 0; line-height: 1.6; color: #cbd5e1;">
                        Oyuna ilk adımını attığında karakter adını belirler ve başlangıç cenneti olan <strong>Burnaz Sahil</strong> kıyılarında uyanırsın. Amacın; oltanı geliştirmek, nadir ve efsanevi balıkların peşine düşmek, Dörtyol şehrinde ticaret yapmak, loncanı zirveye taşımak ve okyanusların hükümdarı olmaktır.
                    </p>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🎮 Temel Tuşlar ve Kontroller</h3>
                <div class="wiki-card" style="padding: 6px 12px;">
                    <table class="wiki-table">
                        <thead>
                            <tr>
                                <th style="width: 25%;">Tuş / Girdi</th>
                                <th style="width: 35%;">Eylem</th>
                                <th>Açıklama & Detay</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td><span class="wiki-badge" style="background:#3b82f6; color:#fff;">Sol Tık</span></td>
                                <td><strong>Hareket / Olta / Etkileşim</strong></td>
                                <td>Haritada tıklandığında karakter o noktaya yürür. Suya tıklandığında oltayı o noktaya fırlatır.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#eab308; color:#000;">SPACE (Boşluk)</span></td>
                                <td><strong>Olta At / Çekiş Kontrolü</strong></td>
                                <td>Su kenarındayken olta atar. Balık vurduğunda minigame'de yeşil yakalama barını yukarı kaldırır.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#10b981; color:#fff;">I Tuşu</span></td>
                                <td><strong>Envanter (Çanta)</strong></td>
                                <td>Tuttuğun balıkları, yemlerini, parşömenlerini, kostümlerini ve oltalarını listeler.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#06b6d4; color:#fff;">K Tuşu</span></td>
                                <td><strong>Yetenek Ağacı</strong></td>
                                <td>Karakterinin 7 adet pasif yeteneğini görüntüler ve seviye puanlarını dağıtmanı sağlar.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#8b5cf6; color:#fff;">O Tuşu</span></td>
                                <td><strong>Auto-Hunt (AFK Modu)</strong></td>
                                <td>Otomatik balık tutma modunu açar veya kapatır. Bilgisayar başında değilken avlanmanı sağlar.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#f59e0b; color:#000;">G Tuşu</span></td>
                                <td><strong>Lonca Penceresi</strong></td>
                                <td>Üyesi olduğun loncanın üyelerini, seviyesini ve Lonca Yetenek Ağacını açar.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#ec4899; color:#fff;">Z Tuşu</span></td>
                                <td><strong>Wiki Rehberi</strong></td>
                                <td>Şu an incelediğin bu kapsamlı oyun ansiklopedisini ve kılavuzunu açar/kapatır.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#ef4444; color:#fff;">P Tuşu</span></td>
                                <td><strong>Kontrol Paneli (GM)</strong></td>
                                <td>Canlı oyun düzenleme, balık oranları, test eşyaları ve lonca seviyesi test araçlarını açar.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#6366f1; color:#fff;">T / Enter</span></td>
                                <td><strong>Genel Sohbet (Chat)</strong></td>
                                <td>T tuşu sohbet kutusunu aktif eder. Mesajını yazıp Enter ile tüm dünyaya gönderebilirsin.</td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#64748b; color:#fff;">ESC</span></td>
                                <td><strong>Pencereleri Kapat</strong></td>
                                <td>Ekranda açık olan envanter, wiki, lonca vb. tüm modalları hızlıca kapatır.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🏆 Seviye, EXP ve Unvan Sistemi</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1;">
                        Oyunda karakterin balık tuttukça tecrübe puanı (EXP) kazanır. Seviye barı ekranın alt orta kısmında bulunur. Karakter seviyesi arttıkça yeni unvanlar kazanırsın:
                    </p>
                    <div class="wiki-grid">
                        <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                            <strong style="color: #94a3b8;">Lv. 1 - 3:</strong> Balıkçı Çırağı
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                            <strong style="color: #38bdf8;">Lv. 4 - 6:</strong> Kıyı Balıkçısı
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                            <strong style="color: #4ade80;">Lv. 7 - 9:</strong> Usta Avcı
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                            <strong style="color: #c084fc;">Lv. 10 - 14:</strong> Deniz Kurdu
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                            <strong style="color: #f59e0b;">Lv. 15 - 19:</strong> Kaptan
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
                            <strong style="color: #f43f5e;">Lv. 20 (Max):</strong> 👑 Okyanus Efsanesi
                        </div>
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🌟 Yeni Başlayanlar İçin 4 Adımlık Başarı Rehberi</h3>
                <div class="wiki-tip" style="margin-bottom: 8px;">
                    <strong>1. Adım:</strong> Kıyıya yaklaş, sol tıkla veya Space tuşu ile oltanı suya bırak. Balık vurduğunda beliren minigame'de yeşil barı balık simgesinin üzerinde dengede tutarak yakala.
                </div>
                <div class="wiki-tip" style="margin-bottom: 8px;">
                    <strong>2. Adım:</strong> Tuttuğun balıkları <strong>Balıkçı Ahmet</strong>'e satarak altın biriktir. İstersen birkaç çipura veya levreği <strong>Şef Gusto</strong>'ya pişirtip tüketerek geçici hız ve şans buff'ı kazan.
                </div>
                <div class="wiki-tip" style="margin-bottom: 8px;">
                    <strong>3. Adım:</strong> Her seviye atladığında <strong>[K]</strong> tuşuna basarak Yetenek Puanlarını dağıt. Özellikle <em>Usta Balıkçı</em> ve <em>Seri Çekiş</em> ilk seviyeler için büyük avantaj sağlar.
                </div>
                <div class="wiki-tip">
                    <strong>4. Adım:</strong> Yeterince güçlendiğinde iskeledeki <strong>Kaptan Reis</strong> ile konuşarak büyük metropol şehri <strong>Dörtyol</strong>'a yelken aç! Orada loncalar, efsunlu örs, simyacılar ve devasa bir pazar seni bekliyor.
                </div>
            </div>
        `;
    } else if (tabKey === 'maps') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">🗺️ Oyun Dünyası ve Haritalar</h3>
                <div class="wiki-card">
                    <p style="margin: 0; line-height: 1.6; color: #cbd5e1;">
                        Oyun dünyası şu anda 2 devasa bölge ve derin açık deniz sularından meydana gelir. İskeledeki <strong>Kaptan Reis</strong> sayesinde bölgeler arasında özgürce seyahat edebilirsin.
                    </p>
                </div>
            </div>

            <div class="wiki-grid">
                <div class="wiki-card">
                    <div style="font-size: 16px; font-weight: 700; color: #38bdf8; margin-bottom: 6px;">🏖️ 1. Burnaz Sahil (Başlangıç Bölgesi)</div>
                    <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin: 0 0 10px 0;">
                        Her maceracının ilk adımlarını attığı huzurlu kıyı kasabası. Hem tatlı su göletleri hem de tuzlu sahil şeridi barındırır.
                    </p>
                    <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: #cbd5e1; line-height: 1.6;">
                        <li><strong>Tatlısu Havzası:</strong> Turna, Sazan, Alabalık ve Yayın balığı avlanır.</li>
                        <li><strong>Tuzlusu Sahili:</strong> Çipura, Levrek, İstavrit gibi kıyı balıkları bulunur.</li>
                        <li><strong>İskele & Kaptan Reis:</strong> Buradan ana şehir Dörtyol'a güvenli geçiş yapılır.</li>
                    </ul>
                </div>

                <div class="wiki-card">
                    <div style="font-size: 16px; font-weight: 700; color: #f59e0b; margin-bottom: 6px;">🏛️ 2. Dörtyol (Ana Şehir & Ticaret Başkenti)</div>
                    <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin: 0 0 10px 0;">
                        Geniş meydanları, tarihi taş yolları, zanaat kuleleri ve lonca tapınağı ile krallığın kalbidir.
                    </p>
                    <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: #cbd5e1; line-height: 1.6;">
                        <li><strong>Merkez Plaza:</strong> Fıskiye, çiçekler, Çırak Çınar ve Kuyumcu Selim yer alır.</li>
                        <li><strong>Balıkçılık & Aşçılık Rıhtımı:</strong> Ahmet, Şef Gusto ve Yemci Tarık dükkanları.</li>
                        <li><strong>Büyü & Zanaat Bölgesi:</strong> Simya Kulesi (Efsun) ve Efsunlu Örs (Anvil).</li>
                        <li><strong>Korsan Butiği & Bahisçi:</strong> Kaptan Barbaros ve Bahisçi Bülo.</li>
                        <li><strong>Lonca Tapınağı Meydanı:</strong> Muazzam Lonca Tapınağı, Lonca Lideri ve Muhafız.</li>
                    </ul>
                </div>
            </div>

            <div class="wiki-section" style="margin-top: 16px;">
                <h3 class="wiki-section-title">🌊 Akdeniz & Açık Denizler (Tekne ile Keşif)</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Kendi tekneni edindikten sonra kıyı sınırlarını aşıp açık Akdeniz sularına açılabilirsin. Açık sularda Kılıç Balığı ve Orkinos gibi devasa trofeler yüzer.
                    </p>
                    <div class="wiki-tip">
                        ✨ <strong>Sarı Parlayan Balık Hotspot'u:</strong> Açık denizlerde periyodik olarak beliren altın rengi parıldayan büyülü bir su girdabıdır! Bu alanın üzerine geldiğinde bekleme süren %50 kısalır ve Nadir / Destansı / Efsanevi balık düşme ihtimali katbekat artar.
                    </div>
                </div>
            </div>
        `;
    } else if (tabKey === 'npcs') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">🏛️ Şehirdeki Tüm NPC'ler ve Görevleri</h3>
                <p style="color: #cbd5e1; font-size: 13px; margin: 0 0 12px 0;">
                    Oyundaki NPC'lerin yanına gidip üzerlerine tıklayarak veya yanlarındayken SPACE'e basarak etkileşime geçebilirsin. Şehirdeki 12 kilit NPC ve uzmanlıkları:
                </p>
                <div class="wiki-grid">
                    <div class="wiki-card">
                        <strong style="color: #38bdf8; font-size: 14px;">⚓ Kaptan Reis</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">İskele & Seyahat Rehberi</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Burnaz Sahil ve Dörtyol şehirleri arasında hızlı ve güvenli vapur seferlerini yönetir.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #38bdf8; font-size: 14px;">🎣 Balıkçı Ahmet</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Balık Borsası & Oltacı</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Tuttuğun tüm balıkları anında nakit altına dönüştürür. Yeni olta modelleri satar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #4ade80; font-size: 14px;">🍳 Şef Gusto</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Usta Aşçı & Restoran</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Çiğ balıkları lezzetli çorba ve tavalara çevirir. Pişmiş balıklar güçlü avlanma buff'ları kazandırır.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #4ade80; font-size: 14px;">🪱 Balıkçı Tarık</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Canlı Yem Tedarikçisi</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Solucan, Karides, Kalamar ve Altın Yem satar. Yem kullanmak nadir balık şansını büyük oranda artırır.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #facc15; font-size: 14px;">📜 Çırak Çınar</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Görevler & Teşvikler</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Sana özel balıkçılık görevleri verir. Görevleri tamamladıkça bol miktarda altın ve tecrübe kazanırsın.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #c084fc; font-size: 14px;">🔮 Simyacı Efsun</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Büyü & Parşömen Kulesi</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Efsun Parşömeni, Kadim Koruma Parşömeni ve İnci ticareti yapar. Zanaatın vazgeçilmezidir.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #fbbf24; font-size: 14px;">💍 Kuyumcu Selim</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Altın & Mücevher Borsası</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Denizden çıkardığın incileri yüksek kurdan nakit altına bozdurmanı sağlar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #ef4444; font-size: 14px;">🔨 Efsunlu Örs (Anvil)</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Ekipman & Kostüm Güçlendirme</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Oltalarını ve kostümlerini +1'den +5'e kadar yükseltir. Her seviye ekstra hız ve nadirlik bonusu verir.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #f97316; font-size: 14px;">🎲 Bahisçi Bülo</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Şans Çarkı & Kumar</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Altın karşılığı şansını dene! Kadim Koruma Parşömeni, İnci ve yüksek kazançlar elde edebilirsin.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #eab308; font-size: 14px;">🏴‍☠️ Kaptan Barbaros</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Kostüm & Stil Butiği</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Özel denizci ve korsan kostümleri satar. Kostümler karakterine hem şıklık hem de güçlü statlar katar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #eab308; font-size: 14px;">⚔️ Lonca Lideri</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Lonca Tapınağı Reisi</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Kendi loncanı kurmanı sağlar. 48 slotluk ortak lonca kasasına erişim sunar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #6366f1; font-size: 14px;">🛡️ Lonca Muhafızı</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Lonca Kalesi Bekçisi</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Lonca kalesinin güvenliğini sağlar, lonca üyelerine özel eşyalar ve destekler sunar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #ffd166; font-size: 14px;">⚖️ Pazarcı Mustafa</strong>
                        <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">Dörtyol Pazarı & Açık Artırma</div>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 0;">Oyuncular arası açık artırma ve pazar yerini yönetir. İstediğin eşyayı istediğin fiyattan satabilir veya diğer tüccarların ilanlarını satın alabilirsin.</p>
                    </div>
                </div>
            </div>
        `;
    } else if (tabKey === 'fishing') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">🎣 Balıkçılık & Minigame Mekaniği</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Balıkçılık oyunun ana omurgasıdır. Su kenarına gidip oltanı attığında sabırla bekle. Balık oltaya vurduğunda ekranın ortasında dinamik bir <strong>Balık Yakalama Minigame'i</strong> başlar!
                    </p>
                    <div class="wiki-tip" style="margin-bottom: 10px;">
                        🎯 <strong>Nasıl Oynanır?</strong> SPACE tuşuna veya Sol Tık'a bastığında yeşil yakalama çubuğu yukarı doğru süzülür, tuşu bıraktığında ise yerçekimiyle aşağı iner. Amacın; yukarı aşağı kaçan hareketli balık simgesini bu yeşil çubuğun içinde tutmaktır.
                    </div>
                    <div class="wiki-warn">
                        ⚠️ Balık yeşil alanın içindeyken sağdaki ilerleme çubuğu hızla dolar (%100 olduğunda balık yakalanır). Eğer balık yeşil alanın dışına çıkarsa bar hızla düşer; çubuk tamamen boşalırsa misina kopar ve balık kaçar!
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">✨ Balık Nadirlikleri & Lonca EXP Katkısı</h3>
                <div class="wiki-card" style="padding: 6px 12px;">
                    <table class="wiki-table">
                        <thead>
                            <tr>
                                <th>Nadirlik</th>
                                <th>Örnek Türler</th>
                                <th>Zorluk</th>
                                <th>Lonca EXP</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td><span class="wiki-badge" style="background:#94a3b8; color:#000;">⚪ Sıradan (Common)</span></td>
                                <td>Turna, Hamsi, İstavrit</td>
                                <td>Kolay, yavaş hareket</td>
                                <td><strong style="color:#4ade80;">+%1 Lonca EXP</strong></td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#22c55e; color:#000;">🟢 Gelişmiş (Uncommon)</span></td>
                                <td>Çipura, Alabalık, Palamut</td>
                                <td>Orta hızda manevralar</td>
                                <td><strong style="color:#4ade80;">+%2 Lonca EXP</strong></td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#3b82f6; color:#fff;">🔵 Nadir (Rare)</span></td>
                                <td>Levrek, Sazan, Lagos</td>
                                <td>Hızlı ve ani yön değişimleri</td>
                                <td><strong style="color:#4ade80;">+%3 Lonca EXP</strong></td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#a855f7; color:#fff;">🟣 Destansı (Epic)</span></td>
                                <td>Orfoz, Somon, Dev Kalamar</td>
                                <td>Oldukça çevik, yüksek direnç</td>
                                <td><strong style="color:#4ade80;">+%4 Lonca EXP</strong></td>
                            </tr>
                            <tr>
                                <td><span class="wiki-badge" style="background:#f59e0b; color:#000;">🟠 Efsanevi (Legendary)</span></td>
                                <td>Kılıç Balığı, Mavi Orkinos</td>
                                <td>Usta refleksler gerektirir</td>
                                <td><strong style="color:#ffd166;">+%5 Lonca EXP</strong></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🪱 Yemlerin Önemi & Etkileri</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Envanterinden bir yemi olta yuvasına taktığında her avda tüketilir (veya <em>Yem Ustası</em> yeteneği ile korunur). Yemler yakalama hızını ve nadir balık çıkma oranını katlar:
                    </p>
                    <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #cbd5e1; line-height: 1.6;">
                        <li><strong>Solucan:</strong> Temel yem. Küçük ve tatlı su balıklarının ilgisini çeker.</li>
                        <li><strong>Karides:</strong> Kıyı sularında çipura ve levrek gibi değerli türleri çeker.</li>
                        <li><strong>Kalamar:</strong> Derin deniz balıkları ve destansı türler için en etkili yemdir.</li>
                        <li><strong>Altın Yem:</strong> Efsanevi canavarları yüzeye çekme şansı veren büyülü yem!</li>
                    </ul>
                </div>
            </div>
        `;
    } else if (tabKey === 'anvil') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">🔨 Efsunlu Örs (Anvil) Sistemi</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Dörtyol Zanaat Kulesi'nin hemen yanında bulunan <strong>Efsunlu Örs</strong>, ekipmanlarının potansiyelini zirveye çıkarır. Tüm oltalar ve kostümler <strong>en fazla +5 seviyeye kadar</strong> güçlendirilebilir.
                    </p>
                    <p style="margin: 0; color: #94a3b8; font-size: 13px;">
                        Güçlendirme işlemi için envanterinde <strong>Efsun Parşömeni</strong> bulunması gerekir.
                    </p>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🛡️ Kadim Koruma Parşömeni & Yanma Koruması</h3>
                <div class="wiki-card">
                    <div class="wiki-tip" style="margin-bottom: 10px;">
                        🛡️ <strong>Kadim Koruma Parşömeni:</strong> Yüksek seviyelere (+3, +4, +5) eşya basarken başarısız olursan eşyanın kırılmasını veya seviyesinin düşmesini %100 engelleyen eşsiz bir koruyucu büyüdür.
                    </div>
                    <p style="margin: 0; font-size: 13px; color: #cbd5e1; line-height: 1.5;">
                        Kadim Koruma Parşömeni'ni Simyacı Efsun'dan satın alabilir, Bahisçi Bülo'nun çarkından kazanabilir veya açık denizlerde avlanırken %1.0 drop şansıyla elde edebilirsin.
                    </p>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">📈 Kümülatif Başarı Bonusu (Pity Mekaniği)</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 8px 0; color: #cbd5e1; line-height: 1.6;">
                        Efsunlu Örs'te yaptığın bir güçlendirme denemesi başarısız olduğunda sistem harcadığın emeği ödüllendirir:
                    </p>
                    <div class="wiki-tip">
                        🌟 <strong>Her başarısız denemede bir sonraki şansına kalıcı +%5 Başarı Oranı eklenir!</strong> Bu bonus eşya başarıyla bir üst seviyeye geçene kadar birikmeye devam eder. Böylece asla sonsuz bir şanssızlık döngüsüne girmezsin.
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">👘 Kostüm Yükseltmeleri (+5 Sınırı)</h3>
                <div class="wiki-card">
                    <p style="margin: 0; color: #cbd5e1; line-height: 1.6;">
                        Oyundaki başlangıç kostümleri (Acemi, Mavi Denizci, Kırmızı Kaptan), Kaptan Barbaros'un butiğindeki 5 korsan kostümü ve efsanevi Kraliyet Muhafızı kostümü dahil <strong>tüm kostümler</strong> örste +5'e basılabilir. Her artı seviyesi balık tutma hızı, auto-hunt verimi ve ekstra koruma yüzdeleri kazandırır!
                    </p>
                </div>
            </div>
        `;
    } else if (tabKey === 'guilds') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">⚔️ Lonca Sistemi & Yönetimi</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Dörtyol Şehrinin doğusunda yer alan <strong>Lonca Tapınağı</strong>'na giderek <strong>Lonca Lideri</strong> ile konuşabilir ve kendi loncanı kurabilirsin!
                    </p>
                    <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #cbd5e1; line-height: 1.6;">
                        <li>Bir loncaya katıldığında veya kurduğunda karakter adının hemen üzerinde <strong>Koyu Sarı</strong> renkle lonca ismin belirir.</li>
                        <li>Klavyeden <strong>[G]</strong> tuşuna basarak istediğin an Lonca Penceresini açabilir, üyeleri, seviyelerini ve online/offline durumlarını görebilirsin.</li>
                        <li>Lonca en fazla <strong>10. Seviyeye</strong> kadar yükselebilir.</li>
                    </ul>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">📦 48 Slotlu Ortak Lonca Kasası</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 8px 0; color: #cbd5e1; line-height: 1.6;">
                        Lonca Lideri NPC'sine tıkladığında açılan <strong>48 Slotlu Lonca Kasası</strong>, tüm lonca üyelerinin ortak kullanımına açık devasa bir depodur.
                    </p>
                    <div class="wiki-tip">
                        🤝 Yedek oltalarını, yemlerini, pişmiş balıklarını veya parşömenlerini kasaya bırakabilir; yeni katılan veya yardıma ihtiyacı olan lonca arkadaşlarınla eşyalarını paylaşabilirsin!
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🌳 Lonca Yetenek Ağacı & Etkileri</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Lonca seviye atladıkça yetenek puanı kazanır. Yalnızca <strong>Lonca Lideri</strong> bu puanları dağıtabilir; ancak aktif edilen tüm yeteneklerden <strong>istisnasız bütün lonca üyeleri</strong> faydalanır:
                    </p>
                    <div class="wiki-grid">
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #ffd166;">🌟 Lonca Kutsaması (1-5 Lv)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Her seviye tüm lonca üyelerine <strong>+%0.5 Efsanevi Balık</strong> yakalama şansı kazandırır.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #38bdf8;">🧪 Lonca Simyacısı (1-5 Lv)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Her seviye tüm lonca üyelerine Anvil'de eşya basarken <strong>+%0.5 Başarı Şansı</strong> sağlar.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #4ade80;">⚡ Lonca Emektarı (1-5 Lv)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Her seviye tüm lonca üyelerinin <strong>Auto-Hunt (AFK) hızını %5</strong> hızlandırır.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #c084fc;">🎲 Lonca Kumarbazı (1-5 Lv)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Bahisçi Bülo'da tüm üyelere <strong>+%0.5 İnci</strong> ve <strong>+%0.5 Koruma Parşömeni</strong> ihtimali verir.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #fb923c;">🪵 Lonca Marangozu (1-5 Lv)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Tüm üyelere balık tutarken <strong>+%0.5 Ölü Denizcinin Hazinesi</strong> düşürme şansı tanır.</p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🔄 Lonca Yeteneklerini Sıfırlama</h3>
                <div class="wiki-tip">
                    Lonca Lideri, Lonca Yetenek Ağacını baştan yapılandırmak ve puanları geri almak istediğinde <strong>5 adet İnci</strong> harcayarak yetenek ağacını sıfırlayabilir.
                </div>
            </div>
        `;
    } else if (tabKey === 'skills') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">📘 Karakter Yetenek Ağacı (K Tuşu)</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Karakterin her seviye atladığında 1 Yetenek Puanı elde eder. <strong>[K]</strong> tuşuna basarak açabileceğin bu menüde yeteneklerini oyun tarzına göre şekillendirebilirsin.
                    </p>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🌟 7 Temel Pasif Yetenek</h3>
                <div class="wiki-grid">
                    <div class="wiki-card">
                        <strong style="color: #38bdf8; font-size: 14px;">🐟 Usta Balıkçı</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Nadir, Destansı ve Efsanevi balıkların oltana vurma ihtimalini kalıcı olarak artırır.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #4ade80; font-size: 14px;">⚡ Seri Çekiş</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Oltayı suya attıktan sonra balığın vurmasını bekleme süresini belirgin şekilde kısaltır.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #facc15; font-size: 14px;">🎣 Sağlam Misina</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Minigame sırasında yeşil barın dışına çıkıldığında ilerleme çubuğunun daha yavaş boşalmasını sağlar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #fbbf24; font-size: 14px;">💰 Bereketli Kasa</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Balıkçı Ahmet'e sattığın her balıktan ekstra yüzdesel altın bonusu kazanmanı sağlar.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #c084fc; font-size: 14px;">🎓 Tecrübeli Avcı</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Tuttuğun her balıktan kazandığın karakter tecrübe puanını (EXP) önemli ölçüde artırır.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #f87171; font-size: 14px;">🤖 Deniz Kurdu</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Auto-Hunt (AFK) modundaki balık bekleme süresini azaltarak otopilot avını hızlandırır.</p>
                    </div>
                    <div class="wiki-card">
                        <strong style="color: #2dd4bf; font-size: 14px;">🪱 Yem Ustası</strong>
                        <p style="font-size: 12.5px; color: #cbd5e1; margin: 6px 0 0 0;">Balık yakalandığında taktığın yemin harcanmama (korunma) olasılığını artırır.</p>
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🔄 Karakter Yeteneklerini Sıfırlama</h3>
                <div class="wiki-tip">
                    Dağıttığın puanlardan memnun kalmazsan, <strong>[K]</strong> menüsündeki "Sıfırla" butonuyla tüm puanlarını geri alabilirsin. Karakter yeteneklerini sıfırlamak için <strong>1 adet İnci</strong> gerekir.
                </div>
            </div>
        `;
    } else if (tabKey === 'autohunt') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">🤖 Auto-Hunt (AFK Modu - O Tuşu)</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Bilgisayar başında olmadığın veya dinlenmek istediğin anlarda <strong>[O]</strong> tuşuna basarak veya sol üstteki Auto-Hunt paneline tıklayarak otomatik avlanma modunu başlatabilirsin.
                    </p>
                    <p style="margin: 0; color: #94a3b8; font-size: 13px; line-height: 1.5;">
                        Karakterin kıyıda veya teknede uygun bir konumdaysa oltayı otomatik olarak suya fırlatır, balık vurduğunda minigame'i kendi çözer ve ödülleri çantana aktarır.
                    </p>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">⚖️ AFK Denge Katsayıları ve Hızlandırma</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Manuel olarak aktif oynayan oyuncuların emeğinin değerini korumak adına standart Auto-Hunt modunda şu katsayılar uygulanır:
                    </p>
                    <ul style="margin: 0 0 10px 0; padding-left: 18px; font-size: 13px; color: #cbd5e1; line-height: 1.6;">
                        <li><strong>4x Bekleme Süresi:</strong> Balık vurma süresi manuel balıkçılığa göre 4 kat daha uzundur.</li>
                        <li><strong>1/3 Nadirlik Oranı:</strong> Nadir ve efsanevi balık düşme şansı 3'te 1 oranına indirgenir.</li>
                    </ul>
                    <div class="wiki-tip">
                        ⚡ <strong>Nasıl Hızlandırılır?</strong> Karakterinin <em>Deniz Kurdu</em> yeteneği, loncadaki <em>Lonca Emektarı</em> pasifi, Anvilde güçlendirilmiş oltalar ve <em>Kraliyet Muhafızı</em> gibi özel kostümler sayesinde Auto-Hunt hızını inanılmaz seviyelere çıkarabilirsin!
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">🚤 Minnkota Motor & GPS Otopilotu</h3>
                <div class="wiki-card">
                    <p style="margin: 0; color: #cbd5e1; line-height: 1.6;">
                        Tekne satın alan maceracılar için özel GPS otopilot sistemi devreye girer. Açık denizde Auto-Hunt aktif edildiğinde tekne otomatik olarak en yakın <strong>Sarı Parlayan Hotspot</strong> bölgesine seyreder, orada demir atar ve bereketli girdap kaybolana dek sabit kalarak avlanmaya devam eder.
                    </p>
                </div>
            </div>
        `;
    } else if (tabKey === 'specials') {
        html = `
            <div class="wiki-section">
                <h3 class="wiki-section-title">💎 Nadir Droplar ve Gizemli Hazineler</h3>
                <div class="wiki-card">
                    <p style="margin: 0 0 10px 0; color: #cbd5e1; line-height: 1.6;">
                        Balık tutarken oltana sadece balıklar takılmaz; denizin derinliklerinden paha biçilmez mistik hazineler ve özel eşyalar da çıkabilir:
                    </p>
                    <div class="wiki-grid">
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #38bdf8;">🦪 İnci (%0.5 Drop İhtimali)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Yetenek ağacı sıfırlama (1 İnci), lonca ağacı sıfırlama (5 İnci) ve simya için ana madendir. Kuyumcuda yüksek fiyata bozdurulabilir.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #fb923c;">📦 Ölü Denizcinin Hazinesi (%1.0 Drop)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Eski batıklardan çıkan kadim sandık. İçerisinden altın, efsun kağıtları ve değerli yemler fışkırır.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #eab308;">🗝️ Korsan Hazinesi (%0.1 Drop)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Aşırı nadir efsanevi sandık! Açıldığında devasa miktarda nakit altın ve nadir eşyalar kazandırır.</p>
                        </div>
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07);">
                            <strong style="color: #a855f7;">🛡️ Kadim Koruma Parşömeni (%1.0 Drop)</strong>
                            <p style="font-size: 12px; color: #cbd5e1; margin: 4px 0 0 0;">Örste eşya yükseltirken yanmayı önleyen paha biçilmez parşömen.</p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="wiki-section">
                <h3 class="wiki-section-title">👑 Efsanevi Kraliyet Muhafızı Kostümü (%0.01 Drop)</h3>
                <div class="wiki-card" style="border: 1px solid rgba(255, 209, 102, 0.4); background: linear-gradient(135deg, rgba(255, 209, 102, 0.08), rgba(59, 130, 246, 0.08));">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                        <span style="font-size: 16px; font-weight: 800; color: #ffd166;">✨ Kraliyet Muhafızı Kostümü</span>
                        <span class="wiki-badge" style="background: #eab308; color: #000; font-weight: 800;">%0.01 Okyanus Drop</span>
                    </div>
                    <p style="font-size: 13px; color: #f1f5f9; line-height: 1.6; margin: 0 0 12px 0;">
                        Okyanusun derinliklerinde %0.01 gibi imkansıza yakın bir şansla düşen, krallığın en seçkin şövalyelerine layık mitik bir kostümdür. Giydiğinde karakterinin etrafında <strong>büyülü altın-mavi ışıltılı parçacık aurası</strong> döner!
                    </p>
                    <div style="font-weight: 700; color: #38bdf8; font-size: 13px; margin-bottom: 8px;">Sağladığı 7 Eşsiz Güç:</div>
                    <div class="wiki-grid">
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            💎 <strong>+%5 Değerli Balık Tutma Şansı</strong>
                        </div>
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            ⚡ <strong>+%10 Balık Tutma Hızı</strong>
                        </div>
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            🤖 <strong>+%10 Auto Hunt Hızlandırma</strong>
                        </div>
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            🪱 <strong>+%20 Balık Yemi Koruma Şansı</strong>
                        </div>
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            🍲 <strong>+%20 Yemek Buff Süresi Uzatma</strong>
                        </div>
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            🔨 <strong>+%5 Anvil Başarı Şansı</strong>
                        </div>
                        <div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 12px; color: #e2e8f0;">
                            🎲 <strong>+%5 Bahisçi Bülo Şansı</strong>
                        </div>
                    </div>
                    <div class="wiki-tip" style="margin-top: 10px;">
                        🔨 Üstelik Kraliyet Muhafızı kostümü Efsunlu Örs'te <strong>+5'e kadar yükseltilebilir</strong>; güçlendirildikçe tüm bu değerler katbekat artar!
                    </div>
                </div>
            </div>
        `;
    }

    contentEl.innerHTML = html;
}

function initWikiSystem() {
    const closeBtn = document.getElementById('close-wiki-btn');
    if (closeBtn) {
        closeBtn.onclick = () => {
            document.getElementById('wiki-modal')?.classList.add('hidden');
        };
    }

    const hudBtn = document.getElementById('hud-wiki-btn');
    if (hudBtn) {
        hudBtn.onclick = () => {
            toggleWikiModal();
        };
    }

    document.querySelectorAll('.wiki-nav-btn').forEach(btn => {
        btn.onclick = () => {
            const tab = btn.getAttribute('data-wikitab');
            if (tab) {
                renderWikiTab(tab);
            }
        };
    });
}


// ============================================================================
// 9.5 OYUN KONTROL PANELİ (CANLI GM & OYUN DÜZENLEYİCİ - P TUŞU)
// ============================================================================
const STORAGE_CONFIG_KEY = 'BURNAZ_ADMIN_CONFIG_V1';

// Başlangıç fabrika ayarlarının yedeği
const DEFAULT_SNAPSHOT = JSON.stringify({
    RARITY,
    ITEMS: Object.fromEntries(Object.entries(ITEMS).filter(([, v]) => v.type !== 'cooked_fish')),
    BOATS,
    PASSIVE_SKILLS,
    GAME_RULES,
    ENCHANT_SUCCESS_RATES,
    MAX_ENCHANT_COUNT,
    QUESTS: DEFAULT_QUESTS,
    KRAKEN_DROPS,
    KRAKEN_EVENT_CONFIG: DEFAULT_KRAKEN_EVENT_CONFIG
});

let activeAdminTab = 'rarities';
let selectedAdminItemId = 'fish_perch';
let adminItemFilter = 'all';

function saveConfigToLocalStorage() {
    try {
        const cleanItems = {};
        Object.entries(ITEMS).forEach(([k, v]) => {
            if (v.type !== 'cooked_fish') {
                const copy = { ...v };
                delete copy.rarity; // rarityKey üzerinden yeniden bağlanır
                cleanItems[k] = copy;
            }
        });
        const payload = {
            RARITY,
            ITEMS: cleanItems,
            BOATS,
            PASSIVE_SKILLS,
            GAME_RULES,
            ENCHANT_SUCCESS_RATES,
            MAX_ENCHANT_COUNT,
            QUESTS,
            KRAKEN_DROPS,
            KRAKEN_EVENT_CONFIG
        };
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(payload));
    } catch (err) {
        console.warn('Ayarlar kaydedilemedi:', err);
    }
}

function applyConfigPayload(payload) {
    if (!payload) return;
    if (payload.RARITY) {
        Object.keys(payload.RARITY).forEach(k => {
            if (RARITY[k]) Object.assign(RARITY[k], payload.RARITY[k]);
        });
    }
    if (payload.BOATS) {
        Object.keys(payload.BOATS).forEach(bk => {
            if (BOATS[bk]) {
                Object.assign(BOATS[bk], payload.BOATS[bk]);
            } else {
                BOATS[bk] = { ...payload.BOATS[bk] };
            }
        });
    }
    if (payload.GAME_RULES) Object.assign(GAME_RULES, payload.GAME_RULES);
    if (Array.isArray(payload.ENCHANT_SUCCESS_RATES)) {
        ENCHANT_SUCCESS_RATES = [...payload.ENCHANT_SUCCESS_RATES];
    }
    if (typeof payload.MAX_ENCHANT_COUNT === 'number') {
        MAX_ENCHANT_COUNT = payload.MAX_ENCHANT_COUNT;
    }
    if (Array.isArray(payload.PASSIVE_SKILLS)) {
        payload.PASSIVE_SKILLS.forEach((sk, idx) => {
            if (PASSIVE_SKILLS[idx]) Object.assign(PASSIVE_SKILLS[idx], sk);
        });
    }
    if (Array.isArray(payload.QUESTS)) {
        QUESTS = payload.QUESTS.map(q => ({ ...q }));
    }
    if (Array.isArray(payload.KRAKEN_DROPS)) {
        KRAKEN_DROPS = payload.KRAKEN_DROPS.map(d => ({ ...d }));
    }
    if (payload.KRAKEN_EVENT_CONFIG) {
        KRAKEN_EVENT_CONFIG = {
            enabled: payload.KRAKEN_EVENT_CONFIG.enabled !== undefined ? payload.KRAKEN_EVENT_CONFIG.enabled : true,
            forceOpen: Boolean(payload.KRAKEN_EVENT_CONFIG.forceOpen),
            intervals: Array.isArray(payload.KRAKEN_EVENT_CONFIG.intervals)
                ? payload.KRAKEN_EVENT_CONFIG.intervals.map(i => ({ ...i }))
                : [...DEFAULT_KRAKEN_EVENT_CONFIG.intervals]
        };
    }
    if (payload.ITEMS) {
        // Önce mevcut pişmiş balıkları temizle
        Object.keys(ITEMS).forEach(k => {
            if (ITEMS[k].type === 'cooked_fish') delete ITEMS[k];
        });
        Object.entries(payload.ITEMS).forEach(([k, val]) => {
            if (ITEMS[k]) {
                Object.assign(ITEMS[k], val);
            } else {
                ITEMS[k] = { ...val };
            }
            if (ITEMS[k].type === 'fish') {
                const rKey = ITEMS[k].rarityKey || 'COMMON';
                ITEMS[k].rarity = RARITY[rKey] || RARITY.COMMON;
            }
            if (ITEMS[k].type === 'rod' && !player.rodEnchants[k]) {
                player.rodEnchants[k] = { count: 0, luck: 0, speed: 0, control: 0 };
            }
        });
    }
    syncCookedFishItems();
    updateAutoHuntPenaltyLabels();
}

function loadConfigFromLocalStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
        if (raw) {
            applyConfigPayload(JSON.parse(raw));
        }
    } catch (e) {
        console.warn('Kayıtlı ayar okunamadı:', e);
    }
}

function updateAutoHuntPenaltyLabels() {
    const tLabel = document.getElementById('ah-time-mult-label');
    const lLabel = document.getElementById('ah-luck-mult-label');
    if (tLabel) tLabel.textContent = `${GAME_RULES.autoHuntTimeMult}x Yavaş`;
    if (lLabel) lLabel.textContent = `x${Number(GAME_RULES.autoHuntLuckMult).toFixed(2)} Oran`;
}

loadConfigFromLocalStorage();

function toggleAdminPanel() {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast('⛔ Kontrol Paneli sadece Yönetici (GM) hesabına açıktır!', '#ff595e');
        return;
    }
    const modal = document.getElementById('admin-modal');
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
        document.getElementById('inventory-modal').classList.add('hidden');
        document.getElementById('npc-modal').classList.add('hidden');
        document.getElementById('skill-modal').classList.add('hidden');
        renderAdminPanel();
    }
}

document.getElementById('hud-admin-btn').addEventListener('click', toggleAdminPanel);
document.getElementById('close-admin-btn').addEventListener('click', toggleAdminPanel);

document.querySelectorAll('[data-admintab]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-admintab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeAdminTab = btn.getAttribute('data-admintab');
        renderAdminPanel();
    });
});

// Dışa Aktar (JSON İndir)
document.getElementById('admin-export-btn').addEventListener('click', () => {
    saveConfigToLocalStorage();
    const dataStr = localStorage.getItem(STORAGE_CONFIG_KEY) || DEFAULT_SNAPSHOT;
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'burnaz_mmo_ayarlar.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('💾 Oyun ayarları JSON olarak indirildi!', '#80ed99');
});

// İçe Aktar (JSON Yükle)
document.getElementById('admin-import-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const parsed = JSON.parse(ev.target.result);
            applyConfigPayload(parsed);
            saveConfigToLocalStorage();
            renderAdminPanel();
            showToast('📂 Ayar dosyası başarıyla yüklendi ve uygulandı!', '#80ed99');
        } catch (err) {
            showToast('⚠️ Geçersiz JSON dosyası!', '#ff595e');
        }
    };
    reader.readAsText(file);
});

// Varsayılana Sıfırla
document.getElementById('admin-reset-btn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_CONFIG_KEY);
    applyConfigPayload(JSON.parse(DEFAULT_SNAPSHOT));
    renderAdminPanel();
    showToast('🔄 Tüm oyun ayarları fabrika değerlerine sıfırlandı!', '#4cc9f0');
});

function renderAdminPanel() {
    const container = document.getElementById('admin-tab-content');
    if (activeAdminTab === 'rarities') {
        renderAdminRaritiesTab(container);
    } else if (activeAdminTab === 'items') {
        renderAdminItemsTab(container);
    } else if (activeAdminTab === 'boats') {
        renderAdminBoatsTab(container);
    } else if (activeAdminTab === 'rules') {
        renderAdminRulesTab(container);
    } else if (activeAdminTab === 'quests') {
        renderAdminQuestsTab(container);
    } else if (activeAdminTab === 'kraken_drops') {
        renderAdminKrakenDropsTab(container);
    } else if (activeAdminTab === 'gm') {
        renderAdminGMTab(container);
    }
}

// SEKME 1: NADİRLİK ORANLARI, EXP VE BUFF AYARLARI
function renderAdminRaritiesTab(container) {
    const keys = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
    const totalChance = keys.reduce((acc, k) => acc + Number(RARITY[k].baseChance || 0), 0);

    let rowsHtml = '';
    keys.forEach(k => {
        const r = RARITY[k];
        rowsHtml += `
            <tr>
                <td><input class="admin-input" data-rkey="${k}" data-rfield="name" value="${r.name}" style="width:110px; font-weight:700; color:${r.color};"></td>
                <td><input type="color" class="admin-color" data-rkey="${k}" data-rfield="color" value="${r.color}"></td>
                <td><input type="number" step="0.5" min="0" max="100" class="admin-input num-sm" data-rkey="${k}" data-rfield="baseChance" value="${r.baseChance}"> %</td>
                <td><input type="number" step="1" min="0" max="100" class="admin-input num-sm" data-rkey="${k}" data-rfield="expGain" value="${r.expGain}"> %</td>
                <td><input type="number" step="1" min="4" max="60" class="admin-input num-sm" data-rkey="${k}" data-rfield="greenWidth" value="${r.greenWidth}"> %</td>
                <td><input type="number" step="0.05" min="0.2" max="6" class="admin-input num-sm" data-rkey="${k}" data-rfield="speed" value="${r.speed}">x</td>
                <td>
                    <select class="admin-select" data-rkey="${k}" data-rfield="buffType" style="width:130px;">
                        <option value="luck" ${r.buffType === 'luck' ? 'selected' : ''}>Şans Artışı (+%)</option>
                        <option value="speed" ${r.buffType === 'speed' ? 'selected' : ''}>Süre Kısalma (-%)</option>
                        <option value="control" ${r.buffType === 'control' ? 'selected' : ''}>Bar Yavaşlatma (-%)</option>
                    </select>
                </td>
                <td><input type="number" step="1" min="1" max="50" class="admin-input num-sm" data-rkey="${k}" data-rfield="buffVal" value="${r.buffVal}"> %</td>
            </tr>
        `;
    });

    container.innerHTML = `
        <div class="npc-panel">
            <div class="npc-panel-header">
                <h3>Balık Sınıfları, Tutma İhtimalleri ve EXP Ayarları</h3>
                <span style="font-size:12.5px; color:${Math.abs(totalChance - 100) < 0.1 ? '#80ed99' : '#ffbe0b'};">
                    Toplam İhtimal: <b>%${totalChance.toFixed(1)}</b> (Sıradan balık kalan boşluğu otomatik tamamlar)
                </span>
            </div>
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Sınıf Adı</th>
                        <th>Renk</th>
                        <th>Tutma İhtimali (%)</th>
                        <th>Verdiği EXP (%)</th>
                        <th>Yeşil Alan (%)</th>
                        <th>Bar Hızı</th>
                        <th>Şef Yemek Buff Türü</th>
                        <th>Buff Gücü (%)</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            <p style="margin-top:10px; font-size:12px; color:#adb5bd;">
                💡 Değişiklik yaptığın anda oyuna otomatik uygulanır ve tarayıcı hafızasına kaydedilir.
            </p>
        </div>
    `;

    container.querySelectorAll('[data-rkey]').forEach(input => {
        input.addEventListener('change', () => {
            const k = input.getAttribute('data-rkey');
            const field = input.getAttribute('data-rfield');
            let val = input.value;
            if (['baseChance', 'expGain', 'greenWidth', 'speed', 'buffVal'].includes(field)) {
                val = parseFloat(val) || 0;
            }
            RARITY[k][field] = val;
            // Buff açıklamasını otomatik güncelle
            const r = RARITY[k];
            r.buffDesc = r.buffType === 'luck'
                ? `Nadir/Efsanevi balık şansını %${r.buffVal} artırır (10 dk)`
                : r.buffType === 'speed'
                ? `Balık tutma süresini %${r.buffVal} azaltır (10 dk)`
                : `Bar hızını %${r.buffVal} yavaşlatır ve şansı artırır (10 dk)`;

            syncCookedFishItems();
            saveConfigToLocalStorage();
            renderAdminRaritiesTab(container);
            showToast(`✅ ${r.name} sınıfı güncellendi!`, r.color);
        });
    });
}

// SEKME 2: EŞYALAR, NPC ALIŞ/SATIŞ FİYATLARI & GÖRSEL DÜZENLEYİCİ
function renderAdminItemsTab(container) {
    const editableItems = Object.values(ITEMS).filter(i => i.type !== 'cooked_fish' && (adminItemFilter === 'all' || i.type === adminItemFilter));
    if (!ITEMS[selectedAdminItemId] || ITEMS[selectedAdminItemId].type === 'cooked_fish') {
        selectedAdminItemId = editableItems[0]?.id || 'fish_perch';
    }
    const selItem = ITEMS[selectedAdminItemId];

    container.innerHTML = `
        <div class="admin-item-layout">
            <!-- Sol: Eşya Listesi ve Yeni Ekle -->
            <div class="npc-panel">
                <div style="display:flex; gap:6px; margin-bottom:10px;">
                    <select id="admin-item-filter" class="admin-select">
                        <option value="all" ${adminItemFilter === 'all' ? 'selected' : ''}>Tüm Eşyalar (${Object.values(ITEMS).filter(i => i.type !== 'cooked_fish').length})</option>
                        <option value="fish" ${adminItemFilter === 'fish' ? 'selected' : ''}>🐟 Balıklar</option>
                        <option value="rod" ${adminItemFilter === 'rod' ? 'selected' : ''}>🎣 Oltalar</option>
                        <option value="bait" ${adminItemFilter === 'bait' ? 'selected' : ''}>🪱 Yemler</option>
                        <option value="scroll" ${adminItemFilter === 'scroll' ? 'selected' : ''}>📜 Efsun Kağıtları</option>
                        <option value="costume" ${adminItemFilter === 'costume' ? 'selected' : ''}>👕 Kostümler</option>
                    </select>
                    <button class="action-btn success" id="admin-add-item-btn" title="Yeni Balık veya Eşya Oluştur" style="white-space:nowrap;">➕ Yeni Ekle</button>
                </div>
                <div class="admin-item-list" id="admin-item-list"></div>
            </div>

            <!-- Sağ: Seçili Eşya Düzenleyici -->
            <div class="npc-panel" id="admin-item-editor"></div>
        </div>
    `;

    document.getElementById('admin-item-filter').onchange = (e) => {
        adminItemFilter = e.target.value;
        renderAdminItemsTab(container);
    };

    document.getElementById('admin-add-item-btn').onclick = () => {
        const newId = 'fish_custom_' + Date.now().toString().slice(-4);
        ITEMS[newId] = {
            id: newId,
            name: 'Yeni Özel Balık',
            type: 'fish',
            habitat: 'both',
            rarityKey: 'RARE',
            typeName: 'Özel Balık (Nadir)',
            desc: 'Kontrol panelinden eklenen özel balık.',
            rarity: RARITY.RARE,
            fishColor: '#00f5d4',
            finColor: '#ff007f',
            buyPrice: 0,
            sellPrice: 180
        };
        syncCookedFishItems();
        saveConfigToLocalStorage();
        selectedAdminItemId = newId;
        adminItemFilter = 'all';
        renderAdminItemsTab(container);
        showToast('✨ Yeni balık oluşturuldu! Sağ panelden adını, fiyatını ve görselini düzenleyebilirsin.', '#80ed99');
    };

    const listEl = document.getElementById('admin-item-list');
    editableItems.forEach(item => {
        const row = document.createElement('div');
        row.className = `admin-item-row ${item.id === selectedAdminItemId ? 'selected' : ''}`;
        row.appendChild(createItemIconCanvas(item));
        const info = document.createElement('div');
        info.style.overflow = 'hidden';
        info.innerHTML = `
            <div style="font-weight:700; font-size:13px; color:#f8f9fa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.name}</div>
            <div style="font-size:11px; color:#adb5bd;">
                ${item.buyPrice !== undefined && item.type !== 'fish' ? `Alış: ${item.buyPrice}🪙 ` : ''}
                ${item.sellPrice !== undefined ? `Satış: ${item.sellPrice}🪙` : ''}
            </div>
        `;
        row.appendChild(info);
        row.onclick = () => {
            selectedAdminItemId = item.id;
            renderAdminItemsTab(container);
        };
        listEl.appendChild(row);
    });

    if (!selItem) return;

    const editorEl = document.getElementById('admin-item-editor');

    // Türe göre özel renk / nitelik alanları
    let specificFieldsHtml = '';
    if (selItem.type === 'fish') {
        specificFieldsHtml = `
            <div class="admin-field">
                <label>Balık Nadirlik Sınıfı</label>
                <select class="admin-select" id="ed-rarityKey">
                    <option value="COMMON" ${selItem.rarityKey === 'COMMON' ? 'selected' : ''}>⚪ Sıradan (${RARITY.COMMON.name})</option>
                    <option value="UNCOMMON" ${selItem.rarityKey === 'UNCOMMON' ? 'selected' : ''}>🟢 Gelişmiş (${RARITY.UNCOMMON.name})</option>
                    <option value="RARE" ${selItem.rarityKey === 'RARE' ? 'selected' : ''}>🔵 Nadir (${RARITY.RARE.name})</option>
                    <option value="EPIC" ${selItem.rarityKey === 'EPIC' ? 'selected' : ''}>🟣 Destansı (${RARITY.EPIC.name})</option>
                    <option value="LEGENDARY" ${selItem.rarityKey === 'LEGENDARY' ? 'selected' : ''}>🟡 Efsanevi (${RARITY.LEGENDARY.name})</option>
                </select>
            </div>
            <div class="admin-field">
                <label>Bulunduğu Su Bölgesi</label>
                <select class="admin-select" id="ed-habitat">
                    <option value="lake" ${selItem.habitat === 'lake' ? 'selected' : ''}>🏞️ Sadece Küçük Göl</option>
                    <option value="sea" ${selItem.habitat === 'sea' ? 'selected' : ''}>🌊 Sadece Büyük Deniz</option>
                    <option value="both" ${selItem.habitat === 'both' ? 'selected' : ''}>🌍 Her İki Su (Göl + Deniz)</option>
                </select>
            </div>
            <div class="admin-field">
                <label>Gövde Rengi (Varsayılan Çizim)</label>
                <input type="color" class="admin-color" id="ed-fishColor" value="${selItem.fishColor || '#48cae4'}">
            </div>
            <div class="admin-field">
                <label>Yüzgeç / Kuyruk Rengi</label>
                <input type="color" class="admin-color" id="ed-finColor" value="${selItem.finColor || '#ffb703'}">
            </div>
        `;
    } else if (selItem.type === 'rod') {
        specificFieldsHtml = `
            <div class="admin-field">
                <label>Olta Şans Bonusu (Baz Çarpan)</label>
                <input type="number" step="0.2" class="admin-input" id="ed-luckBonus" value="${selItem.luckBonus ?? 0}">
            </div>
            <div class="admin-field">
                <label>Olta Gövde Rengi (Eldeki Görünüm)</label>
                <input type="color" class="admin-color" id="ed-rodColor" value="${selItem.rodColor || '#d4a373'}">
            </div>
            <div class="admin-field">
                <label>Olta Ucu Rengi</label>
                <input type="color" class="admin-color" id="ed-rodTip" value="${selItem.rodTip || '#e9c46a'}">
            </div>
            <div class="admin-field">
                <label>Olta Makara Rengi</label>
                <input type="color" class="admin-color" id="ed-reelColor" value="${selItem.reelColor || '#6c757d'}">
            </div>
        `;
    } else if (selItem.type === 'bait') {
        specificFieldsHtml = `
            <div class="admin-field">
                <label>Yem Nadirlik Şans Bonusu</label>
                <input type="number" step="0.5" class="admin-input" id="ed-baitBonus" value="${selItem.baitBonus ?? 1}">
            </div>
        `;
    } else if (selItem.type === 'scroll') {
        specificFieldsHtml = `
            <div class="admin-field">
                <label>Efsun Etki Türü</label>
                <select class="admin-select" id="ed-scrollStat">
                    <option value="luck" ${selItem.scrollStat === 'luck' ? 'selected' : ''}>Şans Artışı (+%)</option>
                    <option value="speed" ${selItem.scrollStat === 'speed' ? 'selected' : ''}>Balık Süresi Kısalma (-%)</option>
                    <option value="control" ${selItem.scrollStat === 'control' ? 'selected' : ''}>Bar Hızı Yavaşlatma (-%)</option>
                </select>
            </div>
            <div class="admin-field">
                <label>Efsun Gücü (% Değer)</label>
                <input type="number" step="1" class="admin-input" id="ed-scrollValue" value="${selItem.scrollValue ?? 4}">
            </div>
            <div class="admin-field">
                <label>Mühür Rengi</label>
                <input type="color" class="admin-color" id="ed-scrollColor" value="${selItem.scrollColor || '#ffbe0b'}">
            </div>
        `;
    } else if (selItem.type === 'costume') {
        specificFieldsHtml = `
            <div class="admin-field">
                <label>Gömlek / Ceket Rengi</label>
                <input type="color" class="admin-color" id="ed-shirt" value="${selItem.shirt || '#3a86ff'}">
            </div>
            <div class="admin-field">
                <label>Yelek / Detay Rengi</label>
                <input type="color" class="admin-color" id="ed-vest" value="${selItem.vest || '#8c6239'}">
            </div>
            <div class="admin-field">
                <label>Pantolon Rengi</label>
                <input type="color" class="admin-color" id="ed-pants" value="${selItem.pants || '#2b2d42'}">
            </div>
            <div class="admin-field">
                <label>Şapka Stili</label>
                <select class="admin-select" id="ed-hat">
                    <option value="straw" ${selItem.hat === 'straw' ? 'selected' : ''}>Hasır Şapka</option>
                    <option value="pirate" ${selItem.hat === 'pirate' ? 'selected' : ''}>Korsan Şapkası</option>
                    <option value="hood" ${selItem.hat === 'hood' ? 'selected' : ''}>Kutup Başlığı</option>
                    <option value="none" ${selItem.hat === 'none' ? 'selected' : ''}>Şapkasız</option>
                </select>
            </div>
        `;
    }

    editorEl.innerHTML = `
        <div class="npc-panel-header">
            <h3>${selItem.name} Düzenleniyor</h3>
            <button class="action-btn success" id="ed-give-item-btn">🎒 Çantama +1 Ver</button>
        </div>

        <!-- Görsel Düzenleme Kutusu -->
        <div class="visual-editor-box">
            <div class="visual-preview-frame" id="ed-preview-holder"></div>
            <div style="flex:1; display:flex; flex-direction:column; gap:8px;">
                <div style="font-size:13px; font-weight:700; color:#ffd166;">🖼️ Eşya Görseli (İkon / Sprite)</div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                    <label class="action-btn primary" style="cursor:pointer;">
                        📁 Bilgisayardan Görsel Seç (PNG/JPG)
                        <input type="file" id="ed-img-file" accept="image/*" style="display:none;">
                    </label>
                    <button class="action-btn danger-btn" id="ed-clear-img-btn" ${!selItem.customImage ? 'disabled' : ''}>
                        🧹 Özel Görseli Kaldır
                    </button>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <input class="admin-input" id="ed-img-url" placeholder="Veya resim URL'si yapıştır (https://...)" value="${selItem.customImage && !selItem.customImage.startsWith('data:') ? selItem.customImage : ''}">
                    <button class="action-btn" id="ed-apply-url-btn" style="white-space:nowrap;">URL Uygula</button>
                </div>
            </div>
        </div>

        <!-- İsim, Fiyat ve Özellik Formu -->
        <div class="admin-form-grid">
            <div class="admin-field">
                <label>Eşya / Balık Adı</label>
                <input class="admin-input" id="ed-name" value="${selItem.name}">
            </div>
            <div class="admin-field">
                <label>Kategori Başlığı</label>
                <input class="admin-input" id="ed-typeName" value="${selItem.typeName || ''}">
            </div>
            <div class="admin-field">
                <label>NPC Alış Fiyatı (🪙 Altın)</label>
                <input type="number" min="0" class="admin-input" id="ed-buyPrice" value="${selItem.buyPrice ?? 0}">
            </div>
            <div class="admin-field">
                <label>NPC Satış Fiyatı (🪙 Altın)</label>
                <input type="number" min="0" class="admin-input" id="ed-sellPrice" value="${selItem.sellPrice ?? 0}">
            </div>
            <div class="admin-field full">
                <label>Açıklama Metni</label>
                <input class="admin-input" id="ed-desc" value="${selItem.desc || ''}">
            </div>
            ${specificFieldsHtml}
        </div>

        <div style="margin-top:14px; display:flex; justify-content:flex-end;">
            <button class="action-btn primary" id="ed-save-item-btn" style="padding:9px 22px; font-size:13.5px;">💾 Değişiklikleri Uygula & Kaydet</button>
        </div>
    `;

    document.getElementById('ed-preview-holder').appendChild(createItemIconCanvas(selItem));

    document.getElementById('ed-give-item-btn').onclick = () => {
        if (addItemToInventory(selItem.id, 1)) {
            showToast(`🎒 1x ${selItem.name} çantana eklendi!`, '#80ed99');
        } else {
            showToast('⚠️ Çantan dolu!', '#ff595e');
        }
    };

    // Dosyadan Görsel Yükleme
    document.getElementById('ed-img-file').onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            selItem.customImage = ev.target.result;
            getCustomImageObj(selItem.customImage);
            syncCookedFishItems();
            saveConfigToLocalStorage();
            setTimeout(() => renderAdminItemsTab(container), 80);
            showToast(`🖼️ ${selItem.name} görseli güncellendi!`, '#80ed99');
        };
        reader.readAsDataURL(file);
    };

    // URL'den Görsel Yükleme
    document.getElementById('ed-apply-url-btn').onclick = () => {
        const url = document.getElementById('ed-img-url').value.trim();
        if (!url) return;
        selItem.customImage = url;
        getCustomImageObj(url);
        syncCookedFishItems();
        saveConfigToLocalStorage();
        setTimeout(() => renderAdminItemsTab(container), 120);
        showToast(`🖼️ ${selItem.name} URL görseli uygulandı!`, '#80ed99');
    };

    document.getElementById('ed-clear-img-btn').onclick = () => {
        delete selItem.customImage;
        syncCookedFishItems();
        saveConfigToLocalStorage();
        renderAdminItemsTab(container);
        showToast(`🧹 ${selItem.name} varsayılan vektörel görsele döndürüldü.`, '#4cc9f0');
    };

    // Form Kaydetme
    document.getElementById('ed-save-item-btn').onclick = () => {
        selItem.name = document.getElementById('ed-name').value.trim() || selItem.name;
        selItem.typeName = document.getElementById('ed-typeName').value.trim();
        selItem.buyPrice = Math.max(0, parseInt(document.getElementById('ed-buyPrice').value) || 0);
        selItem.sellPrice = Math.max(0, parseInt(document.getElementById('ed-sellPrice').value) || 0);
        selItem.desc = document.getElementById('ed-desc').value;

        if (selItem.type === 'fish') {
            selItem.rarityKey = document.getElementById('ed-rarityKey').value;
            selItem.rarity = RARITY[selItem.rarityKey] || RARITY.COMMON;
            selItem.habitat = document.getElementById('ed-habitat').value;
            selItem.fishColor = document.getElementById('ed-fishColor').value;
            selItem.finColor = document.getElementById('ed-finColor').value;
        } else if (selItem.type === 'rod') {
            selItem.luckBonus = parseFloat(document.getElementById('ed-luckBonus').value) || 0;
            selItem.rodColor = document.getElementById('ed-rodColor').value;
            selItem.rodTip = document.getElementById('ed-rodTip').value;
            selItem.reelColor = document.getElementById('ed-reelColor').value;
        } else if (selItem.type === 'bait') {
            selItem.baitBonus = parseFloat(document.getElementById('ed-baitBonus').value) || 0;
        } else if (selItem.type === 'scroll') {
            selItem.scrollStat = document.getElementById('ed-scrollStat').value;
            selItem.scrollValue = parseFloat(document.getElementById('ed-scrollValue').value) || 1;
            selItem.scrollColor = document.getElementById('ed-scrollColor').value;
        } else if (selItem.type === 'costume') {
            selItem.shirt = document.getElementById('ed-shirt').value;
            selItem.vest = document.getElementById('ed-vest').value;
            selItem.pants = document.getElementById('ed-pants').value;
            selItem.hat = document.getElementById('ed-hat').value;
        }

        syncCookedFishItems();
        saveConfigToLocalStorage();
        renderAdminItemsTab(container);
        showToast(`✅ ${selItem.name} başarıyla güncellendi!`, '#80ed99');
    };
}

// SEKME 2.5: TEKNELER & AKDENİZ HARİTASI AYARLARI (GM KONTROL PANELİ)
function renderAdminBoatsTab(container) {
    let boatCardsHtml = '';
    Object.values(BOATS).forEach(b => {
        boatCardsHtml += `
            <div class="shop-card" style="align-items:flex-start; margin-bottom:12px;">
                <div class="shop-card-left" id="admin-boat-icon-${b.id}" style="width:50px;"></div>
                <div style="flex:1;">
                    <div style="display:flex; gap:8px; margin-bottom:6px;">
                        <input class="admin-input" data-boatid="${b.id}" data-bfield="name" value="${b.name}" style="font-weight:700; width:170px;">
                        <input class="admin-input" data-boatid="${b.id}" data-bfield="speedLabel" value="${b.speedLabel}" style="width:110px;" placeholder="Hız Etiketi">
                    </div>
                    <div class="admin-form-grid" style="grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));">
                        <div class="admin-field">
                            <label>Hareket Hızı</label>
                            <input type="number" step="0.2" min="1" max="15" class="admin-input" data-boatid="${b.id}" data-bfield="speed" value="${b.speed}">
                        </div>
                        <div class="admin-field">
                            <label>Fiyat (🪙 Altın)</label>
                            <input type="number" min="0" class="admin-input" data-boatid="${b.id}" data-bfield="price" value="${b.price}">
                        </div>
                        <div class="admin-field">
                            <label>Gövde Rengi</label>
                            <input type="color" class="admin-color" data-boatid="${b.id}" data-bfield="hullColor" value="${b.hullColor}">
                        </div>
                        <div class="admin-field">
                            <label>Detay / Çizgi Rengi</label>
                            <input type="color" class="admin-color" data-boatid="${b.id}" data-bfield="accentColor" value="${b.accentColor}">
                        </div>
                    </div>
                    <div class="admin-field full" style="margin-top:6px;">
                        <label>Açıklama</label>
                        <input class="admin-input" data-boatid="${b.id}" data-bfield="desc" value="${b.desc}">
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>⛵ Tekne Çeşitleri, Hızları & Fiyatları</h3>
                </div>
                <div id="admin-boats-list-wrap">${boatCardsHtml}</div>
                <button class="action-btn primary" id="save-boats-cfg-btn" style="width:100%; padding:9px; margin-top:8px;">💾 Tekne Değerlerini Kaydet</button>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🌊 Akdeniz & Sarı Bölge (Hotspot) & Drop Oranları</h3>
                </div>
                <div class="admin-form-grid">
                    <div class="admin-field">
                        <label>Akdeniz Min. Giriş Seviyesi (Lv)</label>
                        <input type="number" min="1" max="10" class="admin-input" id="cfg-akdeniz-lv" value="${GAME_RULES.akdenizMinLevel ?? 10}">
                    </div>
                    <div class="admin-field">
                        <label>Sarı Bölge Şans Çarpanı (1.5x)</label>
                        <input type="number" step="0.1" min="1" max="5" class="admin-input" id="cfg-hotspot-mult" value="${GAME_RULES.hotspotLuckMult ?? 1.5}">
                    </div>
                    <div class="admin-field">
                        <label>Sarı Alan Değişme Süresi (Saniye)</label>
                        <input type="number" step="10" min="30" max="1800" class="admin-input" id="cfg-hotspot-dur" value="${GAME_RULES.hotspotDurationSec ?? 300}">
                    </div>
                    <div class="admin-field">
                        <label>Sarı Alan Yarıçapı</label>
                        <input type="number" step="0.5" min="1" max="8" class="admin-input" id="cfg-hotspot-rad" value="${GAME_RULES.hotspotRadius ?? 2.8}">
                    </div>
                    <div class="admin-field">
                        <label>İnci Drop İhtimali (%)</label>
                        <input type="number" step="0.1" min="0" max="100" class="admin-input" id="cfg-drop-pearl" value="${GAME_RULES.pearlDropChance ?? 0.5}">
                    </div>
                    <div class="admin-field">
                        <label>Ölü Denizcinin Hazinesi Drop (%)</label>
                        <input type="number" step="0.1" min="0" max="100" class="admin-input" id="cfg-drop-treasure" value="${GAME_RULES.treasureDropChance ?? 1.0}">
                    </div>
                    <div class="admin-field">
                        <label>Korsan Hazinesi Drop (%) (Sarı Bölge)</label>
                        <input type="number" step="0.05" min="0" max="100" class="admin-input" id="cfg-drop-pirate-treasure" value="${GAME_RULES.pirateTreasureDropChance ?? 0.1}">
                    </div>
                    <div class="admin-field">
                        <label>Kraliyet Muhafızı Drop (%) (Akdeniz Okyanus)</label>
                        <input type="number" step="0.005" min="0" max="100" class="admin-input" id="cfg-drop-royal-guard" value="${GAME_RULES.royalGuardDropChance ?? 0.01}">
                    </div>
                </div>

                <div style="margin-top:16px; display:flex; gap:8px;">
                    <button class="action-btn primary" id="save-ocean-rules-btn" style="flex:1; padding:9px;">💾 Akdeniz Ayarlarını Kaydet</button>
                    <button class="action-btn success" id="force-relocate-hotspot-btn">🌟 Sarı Alanı Şimdi Değiştir</button>
                </div>
            </div>
        </div>
    `;

    Object.values(BOATS).forEach(b => {
        const h = document.getElementById(`admin-boat-icon-${b.id}`);
        if (h) h.appendChild(createBoatIconCanvas(b));
    });

    document.getElementById('save-boats-cfg-btn').onclick = () => {
        container.querySelectorAll('[data-boatid]').forEach(inp => {
            const bid = inp.getAttribute('data-boatid');
            const field = inp.getAttribute('data-bfield');
            let val = inp.value;
            if (field === 'speed' || field === 'price') {
                val = parseFloat(val) || 0;
            }
            if (BOATS[bid]) BOATS[bid][field] = val;
        });
        saveConfigToLocalStorage();
        renderAdminBoatsTab(container);
        showToast('✅ Tekne ayarları başarıyla kaydedildi!', '#80ed99');
    };

    document.getElementById('save-ocean-rules-btn').onclick = () => {
        GAME_RULES.akdenizMinLevel = parseInt(document.getElementById('cfg-akdeniz-lv').value) || 10;
        GAME_RULES.hotspotLuckMult = parseFloat(document.getElementById('cfg-hotspot-mult').value) || 1.5;
        GAME_RULES.hotspotDurationSec = parseInt(document.getElementById('cfg-hotspot-dur').value) || 300;
        GAME_RULES.hotspotRadius = parseFloat(document.getElementById('cfg-hotspot-rad').value) || 2.8;
        GAME_RULES.pearlDropChance = parseFloat(document.getElementById('cfg-drop-pearl').value) || 0.5;
        GAME_RULES.treasureDropChance = parseFloat(document.getElementById('cfg-drop-treasure').value) || 1.0;
        GAME_RULES.pirateTreasureDropChance = parseFloat(document.getElementById('cfg-drop-pirate-treasure').value) || 0.1;
        GAME_RULES.royalGuardDropChance = parseFloat(document.getElementById('cfg-drop-royal-guard')?.value) || 0.01;

        saveConfigToLocalStorage();
        showToast('✅ Akdeniz, Sarı Alan ve Drop kuralları kaydedildi!', '#80ed99');
    };

    document.getElementById('force-relocate-hotspot-btn').onclick = () => {
        relocateOceanHotspot(true);
        showToast(`🌟 Sarı Bereket Bölgesi yeni koordinatlara taşındı! (${oceanHotspot.x.toFixed(1)}, ${oceanHotspot.y.toFixed(1)})`, '#ffd166');
    };
}

// SEKME 3: EFSUN ORANLARI, YETENEK AĞACI VE OYUN KURALLARI
function renderAdminRulesTab(container) {
    let enchantInputsHtml = '';
    for (let i = 0; i < 5; i++) {
        enchantInputsHtml += `
            <div class="admin-field">
                <label>${i + 1}. Efsun Başarı Şansı (%)</label>
                <input type="number" min="1" max="100" class="admin-input" data-enchidx="${i}" value="${ENCHANT_SUCCESS_RATES[i] ?? 10}">
            </div>
        `;
    }

    let skillRowsHtml = '';
    PASSIVE_SKILLS.forEach((sk, idx) => {
        skillRowsHtml += `
            <tr>
                <td><input class="admin-input" data-skidx="${idx}" data-skfield="name" value="${sk.name}"></td>
                <td><input type="number" step="0.5" min="0.5" max="50" class="admin-input num-sm" data-skidx="${idx}" data-skfield="effectPerLevel" value="${sk.effectPerLevel}"> %</td>
                <td><input type="number" step="1" min="1" max="10" class="admin-input num-sm" data-skidx="${idx}" data-skfield="maxLevel" value="${sk.maxLevel}"></td>
            </tr>
        `;
    });

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>🔨 Efsun Oranları & Anvil Kuralları</h3>
                </div>
                <div class="admin-form-grid">
                    ${enchantInputsHtml}
                    <div class="admin-field">
                        <label>Başarısız Efsunda Olta Silinsin mi?</label>
                        <select class="admin-select" id="rule-destroy-rod">
                            <option value="true" ${GAME_RULES.destroyRodOnFail ? 'selected' : ''}>Evet, Olta Yok Olsun</option>
                            <option value="false" ${!GAME_RULES.destroyRodOnFail ? 'selected' : ''}>Hayır, Olta Korunsun</option>
                        </select>
                    </div>
                </div>

                <div class="npc-panel-header" style="margin-top:18px;">
                    <h3>⏱️ Balık Bekleme Süresi & Auto-Hunt Ayarları</h3>
                </div>
                <div class="admin-form-grid">
                    <div class="admin-field">
                        <label>Min. Balık Vurma Süresi (Sn)</label>
                        <input type="number" min="1" max="60" class="admin-input" id="rule-min-wait" value="${GAME_RULES.minWaitSec}">
                    </div>
                    <div class="admin-field">
                        <label>Max. Balık Vurma Süresi (Sn)</label>
                        <input type="number" min="2" max="120" class="admin-input" id="rule-max-wait" value="${GAME_RULES.maxWaitSec}">
                    </div>
                    <div class="admin-field">
                        <label>Auto-Hunt Süre Çarpanı (Varsayılan: 4x)</label>
                        <input type="number" step="0.5" min="1" max="20" class="admin-input" id="rule-ah-time" value="${GAME_RULES.autoHuntTimeMult}">
                    </div>
                    <div class="admin-field">
                        <label>Auto-Hunt Nadirlik Çarpanı (1/3 = 0.33)</label>
                        <input type="number" step="0.05" min="0.05" max="2" class="admin-input" id="rule-ah-luck" value="${Number(GAME_RULES.autoHuntLuckMult).toFixed(2)}">
                    </div>
                </div>
                <button class="action-btn primary" id="save-rules-btn" style="margin-top:14px; width:100%; padding:9px;">💾 Kuralları Kaydet</button>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <h3>📘 Pasif Yetenek Ağacı (K) Ayarları</h3>
                </div>
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Yetenek Adı</th>
                            <th>Seviye Başı Etki (%)</th>
                            <th>Maks. Seviye</th>
                        </tr>
                    </thead>
                    <tbody>${skillRowsHtml}</tbody>
                </table>
                <button class="action-btn primary" id="save-skills-cfg-btn" style="margin-top:14px; width:100%; padding:9px;">💾 Yetenek Değerlerini Kaydet</button>
            </div>
        </div>
    `;

    document.getElementById('save-rules-btn').onclick = () => {
        container.querySelectorAll('[data-enchidx]').forEach(inp => {
            const idx = parseInt(inp.getAttribute('data-enchidx'));
            ENCHANT_SUCCESS_RATES[idx] = Math.max(1, Math.min(100, parseFloat(inp.value) || 10));
        });
        GAME_RULES.destroyRodOnFail = document.getElementById('rule-destroy-rod').value === 'true';
        GAME_RULES.minWaitSec = Math.max(1, parseFloat(document.getElementById('rule-min-wait').value) || 10);
        GAME_RULES.maxWaitSec = Math.max(GAME_RULES.minWaitSec, parseFloat(document.getElementById('rule-max-wait').value) || 20);
        GAME_RULES.autoHuntTimeMult = Math.max(1, parseFloat(document.getElementById('rule-ah-time').value) || 4);
        GAME_RULES.autoHuntLuckMult = Math.max(0.05, parseFloat(document.getElementById('rule-ah-luck').value) || 0.33);

        updateAutoHuntPenaltyLabels();
        saveConfigToLocalStorage();
        showToast('✅ Efsun ve oyun kuralları güncellendi!', '#80ed99');
    };

    document.getElementById('save-skills-cfg-btn').onclick = () => {
        container.querySelectorAll('[data-skidx]').forEach(inp => {
            const idx = parseInt(inp.getAttribute('data-skidx'));
            const field = inp.getAttribute('data-skfield');
            if (PASSIVE_SKILLS[idx]) {
                PASSIVE_SKILLS[idx][field] = field === 'name' ? inp.value : (parseFloat(inp.value) || 1);
            }
        });
        if (PASSIVE_SKILLS[0]) PASSIVE_SKILLS[0].perLevelText = `Seviye başına Nadirlik Şansı +%${PASSIVE_SKILLS[0].effectPerLevel}`;
        if (PASSIVE_SKILLS[1]) PASSIVE_SKILLS[1].perLevelText = `Seviye başına Balık Tutma Süresi -%${PASSIVE_SKILLS[1].effectPerLevel}`;
        if (PASSIVE_SKILLS[2]) PASSIVE_SKILLS[2].perLevelText = `Seviye başına Bar Hareket Hızı -%${PASSIVE_SKILLS[2].effectPerLevel}`;
        saveConfigToLocalStorage();
        showToast('✅ Yetenek ağacı değerleri güncellendi!', '#80ed99');
    };
}

// SEKME 5: GÖREVLER, GÖREV ÖDÜLLERİ & BAHİSÇİ BÜLO / CRAFT DÜZENLEYİCİ
function renderAdminQuestsTab(container) {
    const pChance = Number(GAME_RULES.gamblerProtectScrollChance ?? 1.0);
    const pearlChance = Number(GAME_RULES.gamblerPearlChance ?? 1.0);
    const emptyChance = Math.max(0, 100 - (pChance + pearlChance));
    const reqPearls = Number(GAME_RULES.craftBurakPearls ?? 5);
    const reqTreasures = Number(GAME_RULES.craftBurakTreasures ?? 2);

    // Tüm eşya listesini toparla (İstenen ve Ödül olarak seçilebilecek eşyalar)
    const allItemEntries = Object.values(ITEMS).filter(it => it.type !== 'cooked_fish');

    const generateItemOptions = (selectedId) => {
        return allItemEntries.map(it => {
            const isSel = it.id === selectedId ? 'selected' : '';
            return `<option value="${it.id}" ${isSel}>${it.name} (${it.typeName || it.type})</option>`;
        }).join('');
    };

    let questRowsHtml = '';
    QUESTS.forEach((q, idx) => {
        questRowsHtml += `
            <div class="admin-quest-card" data-qidx="${idx}">
                <div class="admin-quest-header">
                    <div style="display:flex; align-items:center; gap:8px; flex:1;">
                        <span style="font-size:16px;">⭐</span>
                        <input class="admin-input" data-qidx="${idx}" data-qfield="title" value="${q.title}" placeholder="Görev Başlığı" style="font-weight:700; color:#ffd166; font-size:13px;">
                        <span style="font-size:11px; color:#6c757d; font-family:monospace;">#${q.id}</span>
                    </div>
                    <button class="action-btn danger-btn delete-quest-btn" data-qidx="${idx}" style="padding:4px 8px; font-size:11.5px;" title="Görevi Sil">🗑️ Sil</button>
                </div>
                <div class="admin-field">
                    <input class="admin-input" data-qidx="${idx}" data-qfield="desc" value="${q.desc}" placeholder="Görev Açıklaması / Hikayesi" style="font-size:11.5px; color:#adb5bd;">
                </div>
                <div class="admin-quest-body">
                    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:8px 10px;">
                        <div style="font-size:11px; font-weight:700; color:#4cc9f0; margin-bottom:4px;">📥 İSTENEN TESLİMAT GEREKSİNİMİ</div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <select class="admin-select" data-qidx="${idx}" data-qfield="requiredItem" style="flex:1;">
                                ${generateItemOptions(q.requiredItem)}
                            </select>
                            <input type="number" min="1" max="9999" class="admin-input num-sm" data-qidx="${idx}" data-qfield="requiredCount" value="${q.requiredCount}" title="Gereken Adet">
                            <span style="font-size:11.5px; color:#adb5bd;">Adet</span>
                        </div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:8px 10px;">
                        <div style="font-size:11px; font-weight:700; color:#80ed99; margin-bottom:4px;">🎁 VERİLECEK GÖREV ÖDÜLÜ</div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <select class="admin-select" data-qidx="${idx}" data-qfield="rewardItem" style="flex:1;">
                                ${generateItemOptions(q.rewardItem)}
                            </select>
                            <input type="number" min="1" max="9999" class="admin-input num-sm" data-qidx="${idx}" data-qfield="rewardCount" value="${q.rewardCount}" title="Ödül Adedi">
                            <span style="font-size:11.5px; color:#adb5bd;">Adet</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="npc-split">
            <div class="npc-panel" style="display:flex; flex-direction:column; gap:14px;">
                <div>
                    <div class="npc-panel-header">
                        <h3>🎲 Bahisçi Bülo (Hazine Sandığı Kumarı)</h3>
                    </div>
                    <p style="font-size:12px; color:#ced4da; margin:0 0 10px;">
                        Ölü Denizcinin Hazinesi açılırken uygulanacak kazanma olasılıklarını buradan belirleyebilirsin.
                    </p>
                    <div class="admin-form-grid">
                        <div class="admin-field">
                            <label>Kaybolma Koruması Parşömeni Şansı (%)</label>
                            <input type="number" step="0.1" min="0" max="100" class="admin-input" id="cfg-gambler-protect" value="${pChance}">
                        </div>
                        <div class="admin-field">
                            <label>İnci Kazanma Şansı (%)</label>
                            <input type="number" step="0.1" min="0" max="100" class="admin-input" id="cfg-gambler-pearl" value="${pearlChance}">
                        </div>
                    </div>
                    <div style="margin-top:8px; padding:8px 12px; background:rgba(0,0,0,0.3); border-radius:6px; display:flex; justify-content:space-between; font-size:12px;">
                        <span>💨 Boş Çıkma İhtimali (Otomatik):</span>
                        <b id="cfg-gambler-empty-badge" style="color:#ffb3c1;">%${emptyChance.toFixed(1)}</b>
                    </div>
                    <button class="action-btn primary" id="save-gambler-rates-btn" style="width:100%; margin-top:10px; padding:8px;">💾 Bahisçi Oranlarını Kaydet</button>
                </div>

                <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:14px;">
                    <div class="npc-panel-header">
                        <h3>🪵 Marangoz Çınar - Efsunlu Olta (SOS) Craft</h3>
                    </div>
                    <p style="font-size:12px; color:#ced4da; margin:0 0 10px;">
                        Balıkçı Burak'ın Efsunlu Oltası'nı üretmek için gereken malzeme miktarlarını ayarla.
                    </p>
                    <div class="admin-form-grid">
                        <div class="admin-field">
                            <label>Gereken İnci Adedi</label>
                            <input type="number" min="1" max="999" class="admin-input" id="cfg-craft-pearls" value="${reqPearls}">
                        </div>
                        <div class="admin-field">
                            <label>Gereken Ölü Denizcinin Hazinesi</label>
                            <input type="number" min="1" max="999" class="admin-input" id="cfg-craft-treasures" value="${reqTreasures}">
                        </div>
                    </div>
                    <button class="action-btn primary" id="save-craft-reqs-btn" style="width:100%; margin-top:10px; padding:8px;">💾 Craft Malzemelerini Kaydet</button>
                </div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header">
                    <div>
                        <h3>📜 Muhtar Ahmet - Köy Görevleri (${QUESTS.length} Görev)</h3>
                        <div style="font-size:11.5px; color:#adb5bd; margin-top:2px;">Görev başlıklarını, teslim edilecek balıkları ve verilecek ödülleri anında yönet</div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="action-btn success" id="admin-add-quest-btn" style="padding:6px 10px; font-size:12px;">➕ Yeni Görev</button>
                        <button class="action-btn" id="admin-reset-quests-btn" style="padding:6px 10px; font-size:12px;" title="Görevleri ilk haline döndür">🔄 Sıfırla</button>
                    </div>
                </div>

                <div id="admin-quests-list" style="max-height:55vh; overflow-y:auto; padding-right:4px;">
                    ${questRowsHtml}
                </div>

                <button class="action-btn primary" id="save-all-quests-btn" style="width:100%; margin-top:12px; padding:10px; font-weight:700;">
                    💾 Tüm Görevleri Kaydet ve Uygula
                </button>
            </div>
        </div>
    `;

    // Boş çıkma oranını canlı hesapla
    const protectInp = document.getElementById('cfg-gambler-protect');
    const pearlInp = document.getElementById('cfg-gambler-pearl');
    const emptyBadge = document.getElementById('cfg-gambler-empty-badge');
    const updateGamblerBadge = () => {
        const p = parseFloat(protectInp.value) || 0;
        const pr = parseFloat(pearlInp.value) || 0;
        const e = Math.max(0, 100 - (p + pr));
        emptyBadge.textContent = `%${e.toFixed(1)}`;
    };
    if (protectInp) protectInp.oninput = updateGamblerBadge;
    if (pearlInp) pearlInp.oninput = updateGamblerBadge;

    // Bahisçi Kaydet Butonu
    document.getElementById('save-gambler-rates-btn').onclick = () => {
        const p = Math.max(0, Math.min(100, parseFloat(protectInp.value) || 0));
        const pr = Math.max(0, Math.min(100, parseFloat(pearlInp.value) || 0));
        GAME_RULES.gamblerProtectScrollChance = p;
        GAME_RULES.gamblerPearlChance = pr;
        saveConfigToLocalStorage();
        showToast(`✅ Bahisçi Bülo oranları kaydedildi! (%${p} Koruma Parşömeni, %${pr} İnci)`, '#80ed99');
    };

    // Craft Kaydet Butonu
    document.getElementById('save-craft-reqs-btn').onclick = () => {
        const p = Math.max(1, parseInt(document.getElementById('cfg-craft-pearls').value) || 5);
        const t = Math.max(1, parseInt(document.getElementById('cfg-craft-treasures').value) || 2);
        GAME_RULES.craftBurakPearls = p;
        GAME_RULES.craftBurakTreasures = t;
        saveConfigToLocalStorage();
        showToast(`✅ Efsunlu Olta Craft gereksinimleri güncellendi! (${p} İnci, ${t} Hazine)`, '#80ed99');
    };

    // Yeni Görev Ekle
    document.getElementById('admin-add-quest-btn').onclick = () => {
        const newQid = 'quest_custom_' + Date.now().toString().slice(-4);
        QUESTS.push({
            id: newQid,
            title: 'Yeni Köy Görevi',
            desc: 'Akdeniz sularından köy için balık teslimatı yap.',
            requiredItem: 'fish_perch',
            requiredCount: 20,
            rewardItem: 'item_dead_sailor_treasure',
            rewardCount: 2
        });
        saveConfigToLocalStorage();
        renderAdminQuestsTab(container);
        showToast('➕ Yeni görev eklendi! Listeden gereksinim ve ödülünü düzenleyebilirsin.', '#80ed99');
    };

    // Görevleri Sıfırla
    document.getElementById('admin-reset-quests-btn').onclick = () => {
        QUESTS = JSON.parse(JSON.stringify(DEFAULT_QUESTS));
        saveConfigToLocalStorage();
        renderAdminQuestsTab(container);
        showToast('🔄 Görevler varsayılan 5 köy görevine sıfırlandı!', '#4cc9f0');
    };

    // Görev Sil Butonları
    container.querySelectorAll('.delete-quest-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.getAttribute('data-qidx'));
            if (QUESTS[idx]) {
                const deletedTitle = QUESTS[idx].title;
                QUESTS.splice(idx, 1);
                saveConfigToLocalStorage();
                renderAdminQuestsTab(container);
                showToast(`🗑️ [${deletedTitle}] görevi silindi.`, '#ffbe0b');
            }
        };
    });

    // Tüm Görevleri Kaydet Butonu
    document.getElementById('save-all-quests-btn').onclick = () => {
        container.querySelectorAll('.admin-quest-card').forEach(card => {
            const idx = parseInt(card.getAttribute('data-qidx'));
            if (!QUESTS[idx]) return;
            const title = card.querySelector('[data-qfield="title"]')?.value.trim() || QUESTS[idx].title;
            const desc = card.querySelector('[data-qfield="desc"]')?.value.trim() || QUESTS[idx].desc;
            const reqItem = card.querySelector('[data-qfield="requiredItem"]')?.value || QUESTS[idx].requiredItem;
            const reqCount = Math.max(1, parseInt(card.querySelector('[data-qfield="requiredCount"]')?.value) || 1);
            const rewItem = card.querySelector('[data-qfield="rewardItem"]')?.value || QUESTS[idx].rewardItem;
            const rewCount = Math.max(1, parseInt(card.querySelector('[data-qfield="rewardCount"]')?.value) || 1);

            QUESTS[idx].title = title;
            QUESTS[idx].desc = desc;
            QUESTS[idx].requiredItem = reqItem;
            QUESTS[idx].requiredCount = reqCount;
            QUESTS[idx].rewardItem = rewItem;
            QUESTS[idx].rewardCount = rewCount;
        });
        saveConfigToLocalStorage();
        showToast('✅ Tüm köy görevleri ve ödülleri başarıyla kaydedildi!', '#80ed99');
    };
}

// ============================================================================
// SEKME 5.5: KRAKEN BÖLGESİ ZAMANI & DROP YÖNETİMİ (KONTROL PANELİ)
// ============================================================================
function renderAdminKrakenDropsTab(container) {
    const evStatus = getKrakenEventStatus();
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const intervals = Array.isArray(KRAKEN_EVENT_CONFIG.intervals) ? KRAKEN_EVENT_CONFIG.intervals : [];

    // 1. Kraken Sefer Saatleri Listesi HTML'i
    let intervalRowsHtml = '';
    if (intervals.length === 0) {
        intervalRowsHtml = `
            <div style="padding: 16px; text-align: center; color: #94a3b8; background: rgba(0,0,0,0.25); border-radius: 8px; font-size: 12.5px;">
                Henüz tanımlanmış bir Kraken sefer saati bulunmuyor. Aşağıdaki formdan yeni sefer saati ekleyebilirsiniz.
            </div>
        `;
    } else {
        intervals.forEach((iv, idx) => {
            const isCurrent = isTimeInInterval(currentMin, iv.start, iv.end);
            intervalRowsHtml += `
                <div class="shop-card" style="align-items: center; margin-bottom: 6px; background: rgba(18, 24, 38, 0.9); border: 1.5px solid ${isCurrent ? '#2ec4b6' : 'rgba(255,255,255,0.1)'}; padding: 10px 14px; border-radius: 8px;">
                    <div style="width: 32px; font-size: 20px; text-align: center;">${isCurrent ? '🔥' : '⏰'}</div>
                    <div style="flex: 1; min-width: 160px;">
                        <input type="text" class="admin-input" data-keventidx="${idx}" data-field="label" value="${iv.label || 'Kraken Seferi'}" placeholder="Sefer Adı" style="font-size: 13px; font-weight: 700; color: #ffd166; padding: 5px 8px;">
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span style="font-size: 11px; color: #94a3b8;">Başlangıç:</span>
                            <input type="time" class="admin-input" data-keventidx="${idx}" data-field="start" value="${iv.start}" style="width: 100px; font-weight: 700; color: #2ec4b6; padding: 4px 6px;">
                        </div>
                        <span style="color: #64748b; font-weight: 800;">➔</span>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span style="font-size: 11px; color: #94a3b8;">Bitiş (Tahliye):</span>
                            <input type="time" class="admin-input" data-keventidx="${idx}" data-field="end" value="${iv.end}" style="width: 100px; font-weight: 700; color: #f87171; padding: 4px 6px;">
                        </div>
                    </div>
                    ${isCurrent ? `<span style="font-size: 11px; background: rgba(46,196,182,0.25); color: #2ec4b6; border: 1px solid #2ec4b6; padding: 3px 8px; border-radius: 4px; font-weight: 800; white-space:nowrap;">🔥 ŞU AN AKTİF</span>` : ''}
                    <button class="action-btn danger-btn btn-del-kevent" data-keventidx="${idx}" style="padding: 6px 12px; font-size: 11.5px; white-space:nowrap;" title="Sefer Saatini Sil">
                        🗑️ Sil
                    </button>
                </div>
            `;
        });
    }

    // 2. Drop Kartları HTML'i
    let dropCardsHtml = '';
    if (!KRAKEN_DROPS || KRAKEN_DROPS.length === 0) {
        dropCardsHtml = `
            <div style="padding: 24px; text-align: center; color: #adb5bd; background: rgba(0,0,0,0.25); border-radius: 8px;">
                Henüz Kraken Haritasına tanımlanmış bir drop bulunmuyor. Aşağıdaki formdan yeni drop ekleyebilirsiniz.
            </div>
        `;
    } else {
        KRAKEN_DROPS.forEach((drop, idx) => {
            const it = ITEMS[drop.itemId] || { name: drop.itemId, typeName: 'Bilinmeyen Eşya' };
            dropCardsHtml += `
                <div class="shop-card" style="align-items:center; margin-bottom:10px; background:rgba(20, 26, 42, 0.85); border:1px solid rgba(239, 68, 68, 0.35); padding:10px 14px;">
                    <div class="shop-card-left" id="admin-kdrop-icon-${idx}" style="width:48px;"></div>
                    <div style="flex:1; min-width:180px;">
                        <div style="font-weight:800; color:#ffd166; font-size:14px;">${it.name}</div>
                        <div style="font-size:11px; color:#94a3b8;">${it.typeName || it.type} • ID: <code style="color:#fca5a5;">${drop.itemId}</code></div>
                    </div>
                    <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
                        <div class="admin-field" style="margin:0;">
                            <label style="font-size:11px; color:#cbd5e1;">Düşme İhtimali (%)</label>
                            <div style="display:flex; align-items:center; gap:4px;">
                                <input type="number" step="0.001" min="0.001" max="100" class="admin-input num-sm" data-kdropidx="${idx}" data-field="chance" value="${drop.chance}" style="width:85px; font-weight:700; color:#ffd166;">
                                <span style="font-size:12px; font-weight:700; color:#fca5a5;">%</span>
                            </div>
                        </div>
                        <div class="admin-field" style="margin:0;">
                            <label style="font-size:11px; color:#cbd5e1;">Adet</label>
                            <input type="number" min="1" max="99" class="admin-input num-sm" data-kdropidx="${idx}" data-field="count" value="${drop.count || 1}" style="width:60px;">
                        </div>
                        <div style="display:flex; flex-direction:column; gap:4px;">
                            <label style="font-size:11px; color:#cbd5e1;">Duyuru</label>
                            <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer;">
                                <input type="checkbox" data-kdropidx="${idx}" data-field="announce" ${drop.announce ? 'checked' : ''}> Chat/Toast
                            </label>
                        </div>
                        <button class="action-btn danger-btn btn-del-kdrop" data-kdropidx="${idx}" style="padding:6px 14px; font-size:12px; margin-top:10px;">
                            🗑️ Sil
                        </button>
                    </div>
                </div>
            `;
        });
    }

    const sortedItems = Object.values(ITEMS)
        .filter(it => it.type !== 'cooked_fish')
        .sort((a, b) => a.name.localeCompare(b.name, 'tr'));

    const itemOptions = sortedItems.map(it => `
        <option value="${it.id}">[${it.typeName || it.type}] ${it.name}</option>
    `).join('');

    container.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:16px;">
            <!-- 1. KRAKEN ZAMANI PANELİ (EVENT SAATLERİ & SEFER AYARLARI) -->
            <div class="npc-panel" style="border-color: rgba(46, 196, 182, 0.45); background: linear-gradient(135deg, rgba(16, 32, 48, 0.95) 0%, rgba(10, 20, 32, 0.98) 100%);">
                <div class="npc-panel-header" style="justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 24px;">⏰</span>
                        <div>
                            <h3 style="color: #2ec4b6; margin: 0; font-size: 16px;">Kraken Zamanı (Etkinlik Sefer Saatleri)</h3>
                            <div style="font-size: 11.5px; color: #94a3b8; margin-top: 2px;">
                                Lonca Destroyer'i ile Kızıl Okyanus'a sadece bu saat aralıklarında gidilebilir. Süre sonunda Kraken haritasındakiler otomatik Dörtyol'a tahliye edilir.
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button class="action-btn success" id="btn-save-kraken-events" style="padding: 8px 18px; font-weight: 800; background: linear-gradient(135deg, #2ec4b6, #00b4d8); color: #000;">
                            💾 Saatleri Kaydet
                        </button>
                    </div>
                </div>

                <!-- Canlı Durum & Kontrol Düğmeleri -->
                <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; padding: 12px 14px; background: rgba(0,0,0,0.32); border-radius: 8px; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <div style="font-size: 12px; color: #ced4da; font-weight: 600;">Canlı Durum:</div>
                        <div id="admin-kraken-live-badge" style="padding: 4px 12px; border-radius: 6px; font-weight: 800; font-size: 12.5px; background: ${evStatus.isActive ? 'rgba(46,196,182,0.2)' : 'rgba(239,68,68,0.2)'}; color: ${evStatus.color}; border: 1px solid ${evStatus.color};">
                            ${evStatus.label} ${evStatus.timeRemainingFormatted ? `[${evStatus.timeRemainingFormatted}]` : ''}
                        </div>
                    </div>

                    <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
                        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #ffd166; cursor: pointer; user-select: none;">
                            <input type="checkbox" id="cfg-kraken-enabled-chk" ${KRAKEN_EVENT_CONFIG.enabled ? 'checked' : ''}>
                            <span>Zaman Kısıtlaması Aktif (Yalnızca Belirlenen Saatlerde)</span>
                        </label>

                        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #ffbe0b; cursor: pointer; user-select: none; background: rgba(255,190,11,0.12); padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,190,11,0.3);">
                            <input type="checkbox" id="cfg-kraken-forceopen-chk" ${KRAKEN_EVENT_CONFIG.forceOpen ? 'checked' : ''}>
                            <span>⚡ Test Modu (Anında Zorla Aç)</span>
                        </label>
                    </div>
                </div>

                <!-- Mevcut Event Saatleri Listesi -->
                <div style="margin-top: 14px;">
                    <div style="font-size: 13px; font-weight: 700; color: #cbd5e1; margin-bottom: 8px;">
                        📅 Tanımlı Kraken Sefer Saatleri (${intervals.length})
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        ${intervalRowsHtml}
                    </div>
                </div>

                <!-- Yeni Saat Aralığı Ekle Formu -->
                <div style="margin-top: 14px; padding: 12px 14px; background: rgba(20, 26, 42, 0.7); border: 1px dashed rgba(46,196,182,0.4); border-radius: 8px;">
                    <div style="font-size: 12.5px; font-weight: 700; color: #2ec4b6; margin-bottom: 8px;">
                        ➕ Yeni Kraken Sefer Saati Ekle
                    </div>
                    <div style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
                        <div class="admin-field" style="flex: 2; min-width: 180px; margin: 0;">
                            <label style="font-size: 11px;">Sefer İsmi / Başlığı</label>
                            <input type="text" class="admin-input" id="new-kevent-label-inp" placeholder="örn: Akşam Baskını" value="Kraken Seferi">
                        </div>
                        <div class="admin-field" style="flex: 1; min-width: 120px; margin: 0;">
                            <label style="font-size: 11px;">Başlangıç Saati</label>
                            <input type="time" class="admin-input" id="new-kevent-start-inp" value="20:00" style="color: #ffd166; font-weight: 700;">
                        </div>
                        <div class="admin-field" style="flex: 1; min-width: 120px; margin: 0;">
                            <label style="font-size: 11px;">Bitiş Saati (Tahliye)</label>
                            <input type="time" class="admin-input" id="new-kevent-end-inp" value="21:00" style="color: #fca5a5; font-weight: 700;">
                        </div>
                        <button class="primary-btn" id="btn-add-kraken-event" style="padding: 9px 18px; font-weight: 800; background: linear-gradient(135deg, #2ec4b6, #00b4d8); color: #000; height: 38px;">
                            ➕ Event Saati Ekle
                        </button>
                    </div>
                </div>
            </div>

            <!-- 2. KRAKEN HARİTASI DROP YÖNETİMİ PANELİ -->
            <div class="guild-banner-card" style="margin:0; border-color:#ef4444; background:linear-gradient(135deg, rgba(40, 10, 16, 0.95) 0%, rgba(18, 5, 8, 0.98) 100%);">
                <div class="guild-banner-left">
                    <div class="guild-crest-icon" style="border-color:#ef4444; background:rgba(239,68,68,0.2);">🦑</div>
                    <div>
                        <div class="guild-name-title" style="color:#ef4444;">Kraken Bölgesi Drop Yönetimi</div>
                        <div class="guild-meta-sub">
                            <span>Kızıl Okyanus'ta balık tutulduğunda düşecek eşyaları ve düşme şanslarını (%) canlı düzenle</span>
                        </div>
                    </div>
                </div>
                <div class="guild-stats-strip">
                    <div class="guild-stat-pill" style="border-color:rgba(239,68,68,0.5);">Aktif Drop Sayısı: <b style="color:#fca5a5;">${KRAKEN_DROPS.length}</b></div>
                </div>
            </div>

            <!-- Mevcut Droplar Listesi -->
            <div class="npc-panel" style="border-color:rgba(239,68,68,0.3);">
                <div class="npc-panel-header" style="justify-content:space-between;">
                    <h3>📋 Kraken Haritasında Düşen Eşyalar & Oranlar</h3>
                    <button class="action-btn success" id="btn-save-kraken-drops" style="padding:8px 18px; font-weight:800; background:linear-gradient(135deg, #2ec4b6, #00b4d8); color:#000;">
                        💾 Dropları Kaydet
                    </button>
                </div>
                <div style="margin-top:12px;">
                    ${dropCardsHtml}
                </div>
            </div>

            <!-- Yeni Drop Ekleme Formu -->
            <div class="npc-panel" style="border-color:rgba(255,209,102,0.35); background:rgba(20, 26, 42, 0.7);">
                <div class="npc-panel-header">
                    <h3>➕ Kraken Haritasına Yeni Drop Ekle</h3>
                </div>
                <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-top:10px;">
                    <div class="admin-field" style="flex:2; min-width:240px; margin:0;">
                        <label>Eklenecek Eşya Seçin</label>
                        <select class="admin-input" id="new-kdrop-item-select" style="font-size:12.5px;">
                            ${itemOptions}
                        </select>
                    </div>
                    <div class="admin-field" style="flex:1; min-width:110px; margin:0;">
                        <label>Düşme Oranı (%)</label>
                        <input type="number" step="0.01" min="0.001" max="100" class="admin-input" id="new-kdrop-chance-inp" value="1.0" style="font-weight:700; color:#ffd166;">
                    </div>
                    <div class="admin-field" style="flex:0.8; min-width:80px; margin:0;">
                        <label>Adet</label>
                        <input type="number" min="1" max="99" class="admin-input" id="new-kdrop-count-inp" value="1">
                    </div>
                    <div class="admin-field" style="margin:0; display:flex; flex-direction:column; justify-content:center;">
                        <label style="font-size:11px;">Duyuru</label>
                        <label style="display:flex; align-items:center; gap:4px; font-size:12px; cursor:pointer; height:34px;">
                            <input type="checkbox" id="new-kdrop-announce-chk" checked> Evet
                        </label>
                    </div>
                    <button class="primary-btn" id="btn-add-kraken-drop" style="padding:10px 20px; font-weight:800; background:linear-gradient(135deg, #e5a93c, #b37400); color:#000; height:38px;">
                        ➕ Drop Ekle
                    </button>
                </div>
            </div>
        </div>
    `;

    // Drop İkonlarını canvas olarak bağla
    KRAKEN_DROPS.forEach((drop, idx) => {
        const iconWrap = document.getElementById(`admin-kdrop-icon-${idx}`);
        const it = ITEMS[drop.itemId];
        if (iconWrap && it) {
            iconWrap.appendChild(createItemIconCanvas(it));
        }
    });

    // --- KRAKEN ZAMANI ETKİNLİK DİNLEYİCİLERİ ---
    // 1. Kraken Sefer Saati Silme Butonları
    container.querySelectorAll('.btn-del-kevent').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.getAttribute('data-keventidx'));
            const ev = KRAKEN_EVENT_CONFIG.intervals[idx];
            if (confirm(`[${ev?.label || 'Sefer'}] saat aralığını (${ev?.start} - ${ev?.end}) silmek istediğine emin misin?`)) {
                KRAKEN_EVENT_CONFIG.intervals.splice(idx, 1);
                saveConfigToLocalStorage();
                renderAdminKrakenDropsTab(container);
                showToast('🗑️ Kraken sefer saati listeden silindi!', '#ef4444');
            }
        };
    });

    // 2. Kraken Zamanı Ayarlarını Kaydet Butonu
    const saveEventsBtn = document.getElementById('btn-save-kraken-events');
    if (saveEventsBtn) {
        saveEventsBtn.onclick = () => {
            const enabledChk = document.getElementById('cfg-kraken-enabled-chk');
            const forceChk = document.getElementById('cfg-kraken-forceopen-chk');
            if (enabledChk) KRAKEN_EVENT_CONFIG.enabled = enabledChk.checked;
            if (forceChk) KRAKEN_EVENT_CONFIG.forceOpen = forceChk.checked;

            container.querySelectorAll('[data-keventidx]').forEach(inp => {
                const idx = parseInt(inp.getAttribute('data-keventidx'));
                const field = inp.getAttribute('data-field');
                if (KRAKEN_EVENT_CONFIG.intervals[idx]) {
                    if (field === 'label') {
                        KRAKEN_EVENT_CONFIG.intervals[idx].label = inp.value.trim() || 'Kraken Seferi';
                    } else if (field === 'start') {
                        KRAKEN_EVENT_CONFIG.intervals[idx].start = inp.value;
                    } else if (field === 'end') {
                        KRAKEN_EVENT_CONFIG.intervals[idx].end = inp.value;
                    }
                }
            });

            saveConfigToLocalStorage();
            renderAdminKrakenDropsTab(container);
            showToast('✅ Kraken Zamanı sefer saatleri ve ayarları başarıyla kaydedildi!', '#2ec4b6');
        };
    }

    // 3. Kraken Zamanı Anlık Toggle Dinleyicileri
    const chkEnabled = document.getElementById('cfg-kraken-enabled-chk');
    if (chkEnabled) {
        chkEnabled.onchange = () => {
            KRAKEN_EVENT_CONFIG.enabled = chkEnabled.checked;
            saveConfigToLocalStorage();
            renderAdminKrakenDropsTab(container);
            showToast(chkEnabled.checked ? '⏰ Kraken Zaman kısıtlaması aktif edildi.' : '🌐 Kraken Zaman kısıtlaması kaldırıldı (7/24 Açık).', '#2ec4b6');
        };
    }
    const chkForce = document.getElementById('cfg-kraken-forceopen-chk');
    if (chkForce) {
        chkForce.onchange = () => {
            KRAKEN_EVENT_CONFIG.forceOpen = chkForce.checked;
            saveConfigToLocalStorage();
            renderAdminKrakenDropsTab(container);
            showToast(chkForce.checked ? '⚡ Kraken Seferi test için anında açıldı!' : '⚡ Kraken test modu kapatıldı.', '#ffd166');
        };
    }

    // 4. Yeni Kraken Event Saati Ekle Butonu
    const addEventBtn = document.getElementById('btn-add-kraken-event');
    if (addEventBtn) {
        addEventBtn.onclick = () => {
            const labelInp = document.getElementById('new-kevent-label-inp');
            const startInp = document.getElementById('new-kevent-start-inp');
            const endInp = document.getElementById('new-kevent-end-inp');

            const label = (labelInp?.value || '').trim() || 'Kraken Seferi';
            const start = startInp?.value || '';
            const end = endInp?.value || '';

            if (!start || !end) {
                showToast('⚠️ Lütfen başlangıç ve bitiş saatlerini eksiksiz seçin!', '#ff595e');
                return;
            }

            if (!Array.isArray(KRAKEN_EVENT_CONFIG.intervals)) {
                KRAKEN_EVENT_CONFIG.intervals = [];
            }

            KRAKEN_EVENT_CONFIG.intervals.push({
                id: 'k_ev_' + Date.now(),
                label,
                start,
                end
            });

            saveConfigToLocalStorage();
            renderAdminKrakenDropsTab(container);
            showToast(`🎉 [${label}] sefer saati (${start} - ${end}) listeye eklendi!`, '#2ec4b6');
        };
    }

    // --- KRAKEN DROP DİNLEYİCİLERİ ---
    // Drop Silme Butonları
    container.querySelectorAll('.btn-del-kdrop').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.getAttribute('data-kdropidx'));
            const it = ITEMS[KRAKEN_DROPS[idx]?.itemId];
            if (confirm(`[${it?.name || 'Eşya'}] dropunu Kraken Haritasından silmek istediğine emin misin?`)) {
                KRAKEN_DROPS.splice(idx, 1);
                saveConfigToLocalStorage();
                renderAdminKrakenDropsTab(container);
                showToast('🗑️ Drop listeden kaldırıldı!', '#ef4444');
            }
        };
    });

    // Drop Kaydet Butonu
    const saveBtn = document.getElementById('btn-save-kraken-drops');
    if (saveBtn) {
        saveBtn.onclick = () => {
            container.querySelectorAll('[data-kdropidx]').forEach(inp => {
                const idx = parseInt(inp.getAttribute('data-kdropidx'));
                const field = inp.getAttribute('data-field');
                if (KRAKEN_DROPS[idx]) {
                    if (field === 'chance') {
                        KRAKEN_DROPS[idx].chance = Math.max(0.001, Math.min(100, parseFloat(inp.value) || 0.001));
                    } else if (field === 'count') {
                        KRAKEN_DROPS[idx].count = Math.max(1, parseInt(inp.value) || 1);
                    } else if (field === 'announce') {
                        KRAKEN_DROPS[idx].announce = inp.checked;
                    }
                }
            });
            saveConfigToLocalStorage();
            renderAdminKrakenDropsTab(container);
            showToast('✅ Kraken Haritası drop ayarları başarıyla kaydedildi!', '#80ed99');
        };
    }

    // Yeni Drop Ekle Butonu
    const addBtn = document.getElementById('btn-add-kraken-drop');
    if (addBtn) {
        addBtn.onclick = () => {
            const itemId = document.getElementById('new-kdrop-item-select').value;
            const chance = Math.max(0.001, Math.min(100, parseFloat(document.getElementById('new-kdrop-chance-inp').value) || 1.0));
            const count = Math.max(1, parseInt(document.getElementById('new-kdrop-count-inp').value) || 1);
            const announce = document.getElementById('new-kdrop-announce-chk').checked;

            if (KRAKEN_DROPS.some(d => d.itemId === itemId)) {
                showToast('⚠️ Bu eşya zaten Kraken drop listesinde ekli! Oranını yukarıdaki listeden güncelleyebilirsiniz.', '#ffbe0b');
                return;
            }

            KRAKEN_DROPS.push({ itemId, chance, count, announce });
            saveConfigToLocalStorage();
            renderAdminKrakenDropsTab(container);
            const it = ITEMS[itemId];
            showToast(`🎉 [${it?.name || itemId}] (%${chance}) Kraken Haritası droplarına eklendi!`, '#80ed99');
        };
    }
}

// SEKME 6: GM HIZLI ARAÇLAR (ALTIN, SEVİYE, EŞYA VERME, IŞINLANMA)
function renderAdminGMTab(container) {
    const allItemsOptions = Object.values(ITEMS)
        .map(it => `<option value="${it.id}">${it.name} (${it.typeName || it.type})</option>`)
        .join('');

    container.innerHTML = `
        <div class="gm-cards-grid">
            <div class="npc-panel">
                <div class="npc-panel-header"><h3>🪙 Altın & Seviye Yönetimi</h3></div>
                <div class="admin-form-grid">
                    <div class="admin-field">
                        <label>Karakter Adı</label>
                        <input type="text" maxlength="16" class="admin-input" id="gm-name-inp" value="${player.name || ''}">
                    </div>
                    <div class="admin-field">
                        <label>Mevcut Altın</label>
                        <input type="number" class="admin-input" id="gm-gold-inp" value="${player.gold}">
                    </div>
                    <div class="admin-field">
                        <label>Karakter Seviyesi (1 - 20)</label>
                        <input type="number" min="1" max="20" class="admin-input" id="gm-lv-inp" value="${player.level}">
                    </div>
                    <div class="admin-field">
                        <label>Mevcut EXP (%)</label>
                        <input type="number" min="0" max="100" class="admin-input" id="gm-exp-inp" value="${player.exp}">
                    </div>
                    <div class="admin-field">
                        <label>Yetenek Puanı</label>
                        <input type="number" min="0" max="50" class="admin-input" id="gm-sp-inp" value="${player.skillPoints}">
                    </div>
                </div>
                <div style="display:flex; gap:8px; margin-top:12px;">
                    <button class="action-btn primary" id="gm-apply-stats-btn" style="flex:1;">Uygula</button>
                    <button class="action-btn success" id="gm-add-gold-btn">+1000 🪙 Ekle</button>
                </div>
            </div>

            <div class="npc-panel">
                <div class="npc-panel-header"><h3>🎁 Çantaya Eşya / Balık Gönder</h3></div>
                <div class="admin-form-grid">
                    <div class="admin-field full">
                        <label>Eşya Seç</label>
                        <select class="admin-select" id="gm-give-select">${allItemsOptions}</select>
                    </div>
                    <div class="admin-field">
                        <label>Adet</label>
                        <input type="number" min="1" max="99" class="admin-input" id="gm-give-count" value="1">
                    </div>
                </div>
                <button class="action-btn success" id="gm-give-btn" style="margin-top:12px; width:100%; padding:8px;">🎒 Çantaya Ekle</button>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <button class="action-btn" id="gm-give-royal-btn" style="flex:1; padding:6px 4px; font-size:11px; border-color:#ffd166; color:#ffd166; font-weight:700;">👑 Kraliyet Kostümü</button>
                    <button class="action-btn" id="gm-give-plus5-royal-btn" style="flex:1; padding:6px 4px; font-size:11px; border-color:#00f5d4; color:#00f5d4; font-weight:700;">⚡ +5 Kraliyet</button>
                    <button class="action-btn" id="gm-give-all-costumes-btn" style="flex:1; padding:6px 4px; font-size:11px;">🧵 5 Yeni Kostüm</button>
                </div>

                <div class="npc-panel-header" style="margin-top:16px;"><h3>💠 Hızlı Işınlanma</h3></div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button class="action-btn" id="gm-tp-sahil" style="flex:1;">🏖️ Burnaz Sahil</button>
                    <button class="action-btn" id="gm-tp-dortyol" style="flex:1;">🏛️ Dörtyol (Şehir)</button>
                    <button class="action-btn" id="gm-tp-akdeniz" style="flex:1; border-color:#4cc9f0; color:#4cc9f0;">🌊 Akdeniz (Tekne)</button>
                    <button class="action-btn" id="gm-tp-kraken" style="flex:1; border-color:#ef4444; color:#fca5a5; background:rgba(220,38,38,0.2); font-weight:800;">🦑 Kraken Haritası</button>
                </div>
            </div>

            <!-- GM LONCA YÖNETİMİ & TEST ARAÇLARI -->
            <div class="npc-panel" style="grid-column: 1 / -1; border-color: rgba(229, 169, 60, 0.45); background: linear-gradient(135deg, rgba(20, 26, 42, 0.95), rgba(14, 18, 30, 0.98));">
                <div class="npc-panel-header" style="border-color: rgba(229, 169, 60, 0.3);">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:18px;">🏛️</span>
                        <h3>Lonca Yönetimi & Level Test Araçları (GM)</h3>
                    </div>
                    ${activeGuild ? `<span style="font-size:12px; color:#ffd166;">Lonca: <b>⟨ ${activeGuild.name} ⟩</b> (Lv. ${activeGuild.level || 1} / 10)</span>` : '<span style="font-size:12px; color:#adb5bd;">Henüz bir lonca yok</span>'}
                </div>

                ${activeGuild ? `
                    <div class="admin-form-grid" style="grid-template-columns: repeat(3, 1fr); gap:12px;">
                        <div class="admin-field">
                            <label>Lonca Seviyesi (1 - 10)</label>
                            <input type="number" min="1" max="10" class="admin-input" id="gm-guild-lv" value="${activeGuild.level || 1}">
                        </div>
                        <div class="admin-field">
                            <label>Lonca EXP (%) (0 - 100)</label>
                            <input type="number" min="0" max="100" class="admin-input" id="gm-guild-exp" value="${activeGuild.exp || 0}">
                        </div>
                        <div class="admin-field">
                            <label>Lonca Yetenek Puanı (0 - 25)</label>
                            <input type="number" min="0" max="25" class="admin-input" id="gm-guild-sp" value="${activeGuild.skillPoints || 0}">
                        </div>
                    </div>

                    <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
                        <button class="action-btn success" id="gm-guild-levelup-btn" style="flex:1.2; min-width:180px; font-weight:700; padding:10px 14px; background:linear-gradient(135deg, #2ec4b6, #00b4d8); color:#000;">
                            ⬆️ +1 Lonca Level Atlat
                        </button>
                        <button class="action-btn primary" id="gm-guild-save-btn" style="flex:1; min-width:140px;">
                            💾 Değerleri Kaydet
                        </button>
                        <button class="action-btn" id="gm-guild-add-exp-btn" style="flex:1; min-width:140px;">
                            ➕ +25 Lonca EXP
                        </button>
                        <button class="action-btn" id="gm-guild-add-sp-btn" style="flex:1; min-width:140px; color:#ffd166; border-color:#ffd166;">
                            🌟 +5 Yetenek Puanı
                        </button>
                        <button class="action-btn" id="gm-guild-max-btn" style="flex:1; min-width:160px; background:linear-gradient(135deg, #7209b7, #560bad); border-color:#ffd166; color:#ffd166; font-weight:700;">
                            👑 Seviye 10 Yap (Maks)
                        </button>
                        <button class="action-btn" id="gm-guild-toggle-dest-btn" style="flex:1; min-width:180px; background:rgba(220,38,38,0.25); border-color:#ef4444; color:#fca5a5; font-weight:700;">
                            🚢 Destroyer: ${activeGuild.hasDestroyer ? 'Açık (Kapat)' : 'Kapalı (Aç)'}
                        </button>
                        <button class="action-btn" id="gm-guild-toggle-role-btn" style="flex:1; min-width:180px; background:rgba(46,196,182,0.2); border-color:#2ec4b6; color:#2ec4b6; font-weight:700;">
                            👑 Rol: ${isPlayerGuildLeader() ? 'Lider (Üye Yap)' : 'Üye (Lider Yap)'}
                        </button>
                    </div>
                ` : `
                    <div style="padding:14px 10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                        <div style="font-size:13px; color:#ced4da;">
                            Şu anda bir loncan bulunmuyor. Test edebilmek için tek tıkla test loncası oluşturabilirsin.
                        </div>
                        <button class="action-btn primary" id="gm-create-test-guild-btn" style="padding:10px 18px; font-weight:700; background:linear-gradient(135deg, #e5a93c, #b37400); color:#000;">
                            🏛️ "GM Test Loncası" Oluştur
                        </button>
                    </div>
                `}
            </div>
        </div>
    `;

    document.getElementById('gm-apply-stats-btn').onclick = () => {
        const newName = document.getElementById('gm-name-inp')?.value?.trim();
        if (newName && newName.length >= 2) {
            player.name = newName;
            localStorage.setItem('mmo_character_name', newName);
        }
        player.gold = Math.max(0, parseInt(document.getElementById('gm-gold-inp').value) || 0);
        player.level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, parseInt(document.getElementById('gm-lv-inp').value) || 1));
        player.exp = Math.max(0, Math.min(100, parseInt(document.getElementById('gm-exp-inp').value) || 0));
        player.skillPoints = Math.max(0, parseInt(document.getElementById('gm-sp-inp').value) || 0);
        updateGoldHUD();
        renderBuffBar();
        updateExpHUD();
        showToast('👑 Karakter değerleri güncellendi!', '#ffd166');
    };

    document.getElementById('gm-add-gold-btn').onclick = () => {
        player.gold += 1000;
        updateGoldHUD();
        renderBuffBar();
        renderAdminGMTab(container);
        showToast('🪙 +1000 Altın eklendi!', '#ffd166');
    };

    document.getElementById('gm-give-btn').onclick = () => {
        const id = document.getElementById('gm-give-select').value;
        const cnt = Math.max(1, parseInt(document.getElementById('gm-give-count').value) || 1);
        if (addItemToInventory(id, cnt)) {
            showToast(`🎁 ${cnt}x ${ITEMS[id].name} çantaya eklendi!`, '#80ed99');
        } else {
            showToast('⚠️ Çanta dolu!', '#ff595e');
        }
    };

    document.getElementById('gm-give-royal-btn').onclick = () => {
        if (addItemToInventory('costume_royal_guard', 1)) {
            showToast('👑 Kraliyet Muhafızı Kostümü çantana eklendi!', '#ffd166');
            renderInventoryUI();
        } else {
            showToast('⚠️ Çanta dolu!', '#ff595e');
        }
    };

    document.getElementById('gm-give-plus5-royal-btn').onclick = () => {
        if (addItemToInventory('costume_royal_guard', 1, { count: 5, luck: 20, speed: 30, control: 30 })) {
            showToast('⚡ +5 Efsunlu Kraliyet Muhafızı Kostümü çantana eklendi!', '#00f5d4');
            renderInventoryUI();
        } else {
            showToast('⚠️ Çanta dolu!', '#ff595e');
        }
    };

    document.getElementById('gm-give-all-costumes-btn').onclick = () => {
        const cids = ['costume_sea_dog', 'costume_buccaneer', 'costume_deep_diver', 'costume_corsair', 'costume_master_angler'];
        let added = 0;
        cids.forEach(cid => {
            if (addItemToInventory(cid, 1)) added++;
        });
        showToast(`🧵 ${added}/5 yeni kostüm çantana eklendi!`, '#80ed99');
        renderInventoryUI();
    };

    document.getElementById('gm-tp-sahil').onclick = () => {
        currentMapId = 'burnaz_sahil';
        player.x = 13.5;
        player.y = 11.5;
        player.path = [];
        toggleAdminPanel();
        showToast('🏖️ Burnaz Sahil haritasına ışınlandın!', '#4cc9f0');
    };

    document.getElementById('gm-tp-dortyol').onclick = () => {
        currentMapId = 'dortyol';
        player.x = 13.5;
        player.y = 15.5;
        player.path = [];
        toggleAdminPanel();
        showToast('🏛️ Dörtyol meydanına ışınlandın!', '#4cc9f0');
    };

    document.getElementById('gm-tp-akdeniz').onclick = () => {
        if (!player.ownedBoats.includes(player.activeBoatId)) {
            player.ownedBoats.push(player.activeBoatId || 'boat_boat');
        }
        currentMapId = 'akdeniz';
        player.x = 13.5;
        player.y = 17.5;
        player.path = [];
        toggleAdminPanel();
        showToast('🌊 Akdeniz haritasına tekneyle ışınlandın!', '#4cc9f0');
    };

    const gmKrakenBtn = document.getElementById('gm-tp-kraken');
    if (gmKrakenBtn) {
        gmKrakenBtn.onclick = () => {
            if (activeGuild) {
                activeGuild.hasDestroyer = true;
                activeGuild.krakenActive = true;
                saveGuildData();
            }
            if (!isKrakenEventActive()) {
                KRAKEN_EVENT_CONFIG.forceOpen = true;
                saveConfigToLocalStorage();
                showToast("⚡ [GM Test] Kraken Seferi zamanı test için geçici olarak aktif edildi!", "#ffd166");
            }
            currentMapId = 'kraken';
            player.x = 13.5;
            player.y = 13.5;
            player.path = [];
            toggleAdminPanel();
            showToast("🦑 Kraken Haritası'na Lonca Destroyer'i ile ışınlandın!", '#ffd166');
        };
    }

    // GM LONCA BUTON OLAYLARI
    const gLevelUpBtn = document.getElementById('gm-guild-levelup-btn');
    if (gLevelUpBtn && activeGuild) {
        gLevelUpBtn.onclick = () => {
            if ((activeGuild.level || 1) >= 10) {
                showToast('⚠️ Lonca zaten maksimum seviyede (Lv. 10)!', '#ffbe0b');
                return;
            }
            activeGuild.level = (activeGuild.level || 1) + 1;
            activeGuild.skillPoints = (activeGuild.skillPoints || 0) + 1;
            if (activeGuild.level >= 10) {
                activeGuild.level = 10;
                activeGuild.exp = 100;
            }
            saveGuildData();
            renderAdminGMTab(container);
            showToast(`🎉 Lonca Seviye Atlatıldı! Yeni Seviye: Lv.${activeGuild.level} (+1 Puan)`, '#ffd166');
            addChatMessage('Lonca', `[GM] Lonca Seviye ${activeGuild.level} yapıldı! 1 Lonca Yetenek Puanı eklendi.`, 'system');
        };
    }

    const gSaveBtn = document.getElementById('gm-guild-save-btn');
    if (gSaveBtn && activeGuild) {
        gSaveBtn.onclick = () => {
            const lv = Math.max(1, Math.min(10, parseInt(document.getElementById('gm-guild-lv').value) || 1));
            const exp = Math.max(0, Math.min(100, parseInt(document.getElementById('gm-guild-exp').value) || 0));
            const sp = Math.max(0, parseInt(document.getElementById('gm-guild-sp').value) || 0);
            activeGuild.level = lv;
            activeGuild.exp = exp;
            activeGuild.skillPoints = sp;
            saveGuildData();
            renderAdminGMTab(container);
            showToast(`✅ Lonca değerleri güncellendi! (Lv.${lv}, %${exp} EXP, ${sp} Puan)`, '#80ed99');
        };
    }

    const gAddExpBtn = document.getElementById('gm-guild-add-exp-btn');
    if (gAddExpBtn && activeGuild) {
        gAddExpBtn.onclick = () => {
            if ((activeGuild.level || 1) >= 10) {
                showToast('⚠️ Lonca zaten maksimum seviyede (Lv. 10)!', '#ffbe0b');
                return;
            }
            activeGuild.exp = (activeGuild.exp || 0) + 25;
            if (activeGuild.exp >= 100) {
                activeGuild.level = Math.min(10, (activeGuild.level || 1) + 1);
                activeGuild.skillPoints = (activeGuild.skillPoints || 0) + 1;
                activeGuild.exp = activeGuild.level >= 10 ? 100 : (activeGuild.exp - 100);
                showToast(`🎉 %100 EXP barajı aşıldı! Lonca Lv.${activeGuild.level} oldu!`, '#ffd166');
            } else {
                showToast(`📈 Lonca EXP +%25 eklendi! (Mevcut: %${activeGuild.exp})`, '#80ed99');
            }
            saveGuildData();
            renderAdminGMTab(container);
        };
    }

    const gAddSpBtn = document.getElementById('gm-guild-add-sp-btn');
    if (gAddSpBtn && activeGuild) {
        gAddSpBtn.onclick = () => {
            activeGuild.skillPoints = (activeGuild.skillPoints || 0) + 5;
            saveGuildData();
            renderAdminGMTab(container);
            showToast(`🌟 +5 Lonca Yetenek Puanı eklendi! (Toplam: ${activeGuild.skillPoints})`, '#80ed99');
        };
    }

    const gMaxBtn = document.getElementById('gm-guild-max-btn');
    if (gMaxBtn && activeGuild) {
        gMaxBtn.onclick = () => {
            activeGuild.level = 10;
            activeGuild.exp = 100;
            activeGuild.skillPoints = Math.max(activeGuild.skillPoints || 0, 10);
            saveGuildData();
            renderAdminGMTab(container);
            showToast('👑 Lonca Seviye 10 (Maks) ve en az 10 Yetenek Puanına ayarlandı!', '#ffd166');
            addChatMessage('Lonca', '[GM] Lonca seviyesi maksimum 10. Seviyeye ulaştırıldı!', 'system');
        };
    }

    const gToggleDestBtn = document.getElementById('gm-guild-toggle-dest-btn');
    if (gToggleDestBtn && activeGuild) {
        gToggleDestBtn.onclick = () => {
            activeGuild.hasDestroyer = !activeGuild.hasDestroyer;
            saveGuildData();
            renderAdminGMTab(container);
            showToast(`🚢 Lonca Destroyer'i: ${activeGuild.hasDestroyer ? 'AÇILDI' : 'KAPATILDI'}`, '#ffd166');
        };
    }

    const gToggleRoleBtn = document.getElementById('gm-guild-toggle-role-btn');
    if (gToggleRoleBtn && activeGuild) {
        gToggleRoleBtn.onclick = () => {
            const currentIsLeader = isPlayerGuildLeader();
            if (currentIsLeader) {
                activeGuild.leader = 'Kuzeyli Balıkçı';
                const me = (activeGuild.members || []).find(m => m.isPlayer || m.name === player.name);
                if (me) me.role = 'Üye';
                showToast('👤 Lonca rolün "Üye" olarak değiştirildi!', '#4cc9f0');
            } else {
                activeGuild.leader = player.name || 'Oyuncu';
                const me = (activeGuild.members || []).find(m => m.isPlayer || m.name === player.name);
                if (me) me.role = 'Lider';
                showToast('👑 Lonca rolün "Lider" olarak değiştirildi!', '#ffd166');
            }
            saveGuildData();
            renderAdminGMTab(container);
        };
    }

    const gCreateTestBtn = document.getElementById('gm-create-test-guild-btn');
    if (gCreateTestBtn) {
        gCreateTestBtn.onclick = () => {
            createGuild('GM Test Loncası');
            renderAdminGMTab(container);
            showToast('🏛️ "GM Test Loncası" başarıyla kuruldu!', '#ffd166');
        };
    }
}

// ============================================================================
// 10. GELİŞMİŞ 2.5D GÖRSEL ÇİZİM MOTORU
// ============================================================================
let globalTime = 0;

function drawCharacterPreview() {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    previewCtx.save();
    previewCtx.translate(80, 118);
    previewCtx.scale(1.45, 1.45);
    drawSmoothCharacter(previewCtx, 0, 0, true);
    previewCtx.restore();
}

// ============================================================================
// KRAKEN GÖLGESİ & KIZIL OKYANUS ATMOSFERİ
// ============================================================================
function drawKrakenAtmosphereAndShadow(ctx) {
    if (currentMapId !== 'kraken') return;

    // Devasa Kraken Gölgesi Periyodu (Her 22 saniyede bir döner)
    const cycle = (globalTime % 22);
    let kAlpha = 0;
    if (cycle >= 2.5 && cycle <= 6.5) {
        kAlpha = (cycle - 2.5) / 4.0; // Yavaşça derinliklerden yükselir (Fade in)
    } else if (cycle > 6.5 && cycle < 14.5) {
        kAlpha = 1.0; // Suyun hemen altında tam görünür
    } else if (cycle >= 14.5 && cycle <= 18.5) {
        kAlpha = 1.0 - ((cycle - 14.5) / 4.0); // Yavaşça derinliklere dalarak kaybolur (Fade out)
    } else {
        kAlpha = 0.0; // Derinlerde gizli
    }

    if (kAlpha > 0.01) {
        ctx.save();
        // Kraken'in harita üzerindeki dairesel / süzülen hareketi
        const kx = 13.5 + Math.sin(globalTime * 0.22) * 5.8;
        const ky = 13.5 + Math.cos(globalTime * 0.17) * 5.8;
        const kPos = tileToScreen(kx, ky);

        const headingAngle = Math.atan2(
            Math.cos(globalTime * 0.17) * -0.17,
            Math.sin(globalTime * 0.22) * 0.22
        );

        ctx.translate(kPos.x, kPos.y);
        ctx.rotate(headingAngle * 0.4);

        // A. Suyun altındaki karanlık devasa kan aurası
        const auraGrad = ctx.createRadialGradient(0, 0, 15, 0, 0, 140);
        auraGrad.addColorStop(0, `rgba(8, 1, 3, ${(kAlpha * 0.88).toFixed(2)})`);
        auraGrad.addColorStop(0.45, `rgba(50, 4, 12, ${(kAlpha * 0.65).toFixed(2)})`);
        auraGrad.addColorStop(1, 'rgba(80, 5, 15, 0)');
        ctx.fillStyle = auraGrad;
        ctx.beginPath();
        ctx.ellipse(0, 0, 150, 95, 0, 0, Math.PI * 2);
        ctx.fill();

        // B. Kraken Gövdesi (Mantle / Devasa Kafası)
        ctx.fillStyle = `rgba(14, 2, 5, ${(kAlpha * 0.92).toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(0, -10, 54, 34, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(180, 20, 40, ${(kAlpha * 0.45).toFixed(2)})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // C. 8 Devasa Kıvrılan Dokunaç (Tentacles)
        const tentacleCount = 8;
        for (let i = 0; i < tentacleCount; i++) {
            const side = i % 2 === 0 ? 1 : -1;
            const tIdx = Math.floor(i / 2);
            const baseAngle = (side * 0.5) + (tIdx * 0.4) - 0.7;
            const waveOffset = globalTime * 2.8 + i * 0.9;
            const tLen = 65 + (tIdx * 14);

            const startX = side * (24 + tIdx * 6);
            const startY = -4 + (tIdx * 10);
            const cp1X = startX + Math.cos(baseAngle) * (tLen * 0.45) + Math.sin(waveOffset) * 16;
            const cp1Y = startY + Math.sin(baseAngle) * (tLen * 0.45) + Math.cos(waveOffset) * 14;
            const endX = startX + Math.cos(baseAngle) * tLen + Math.sin(waveOffset * 1.3) * 24;
            const endY = startY + Math.sin(baseAngle) * tLen + Math.cos(waveOffset * 1.3) * 20;

            ctx.strokeStyle = `rgba(12, 1, 4, ${(kAlpha * 0.85).toFixed(2)})`;
            ctx.lineWidth = 14 - tIdx * 2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.quadraticCurveTo(cp1X, cp1Y, endX, endY);
            ctx.stroke();

            // Dokunaç üstü parıldayan vantuzlar (Bioluminescent Vantuzlar)
            ctx.strokeStyle = `rgba(255, 60, 80, ${(kAlpha * 0.55).toFixed(2)})`;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.quadraticCurveTo(cp1X, cp1Y, endX, endY);
            ctx.stroke();
        }

        // D. Parlayan Korkutucu Gözler (Kızıl-Altın Kraken Gözleri)
        const eyeGlow = Math.sin(globalTime * 4) * 2;
        ctx.fillStyle = `rgba(255, 200, 10, ${(kAlpha * 0.85).toFixed(2)})`;
        ctx.shadowColor = '#ffbe0b';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.ellipse(-14, -8, 5 + eyeGlow * 0.4, 3, 0.2, 0, Math.PI * 2);
        ctx.ellipse(14, -8, 5 + eyeGlow * 0.4, 3, -0.2, 0, Math.PI * 2);
        ctx.fill();

        // Göz Bebeği (İnce dikey yarık)
        ctx.fillStyle = `rgba(0, 0, 0, ${(kAlpha * 0.95).toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(-14, -8, 1.2, 3, 0.2, 0, Math.PI * 2);
        ctx.ellipse(14, -8, 1.2, 3, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // E. Yüzeyde köpüren girdap & baloncuklar
        for (let b = 0; b < 6; b++) {
            const bX = Math.sin(globalTime * 3 + b) * 35;
            const bY = Math.cos(globalTime * 2.5 + b) * 25;
            ctx.fillStyle = `rgba(255, 220, 230, ${(kAlpha * 0.6).toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(bX, bY, 2.5 + (b % 2), 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }
}

// ============================================================================
// LONCA DESTROYER'İ & GÜVERTEDE BALIK TUTAN MÜRETTEBAT ÇİZİMİ
// ============================================================================
function drawGuildDestroyerWithCrew(g, x, y, bY) {
    const guildName = (activeGuild && activeGuild.name) ? activeGuild.name : (player.guildName || 'Lonca');
    const isLeader = isPlayerGuildLeader();

    // 1. Su Köpüğü & Dalga İzi (Wake Foam)
    g.fillStyle = 'rgba(255, 255, 255, 0.55)';
    g.beginPath();
    g.ellipse(x, bY + 12, 75, 24, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255, 180, 190, 0.45)';
    g.beginPath();
    g.ellipse(x, bY + 14, 85, 28, 0, 0, Math.PI * 2);
    g.fill();

    // 2. Ana Zırhlı Gövde (Obsidian Black & Crimson Armor)
    g.fillStyle = '#18181b';
    g.beginPath();
    g.moveTo(x - 68, bY);          // Arka kıç bordası
    g.lineTo(x + 72, bY - 8);       // Ön burun / pruva
    g.lineTo(x + 84, bY - 3);       // Pruva mahmuzu (Naval ram)
    g.lineTo(x + 62, bY + 22);      // Ön alt borda
    g.lineTo(x - 56, bY + 24);      // Arka alt borda
    g.closePath();
    g.fill();
    g.strokeStyle = '#dc2626';     // Kırmızı zırh kuşağı
    g.lineWidth = 2.5;
    g.stroke();

    // 3. Güverte Zemin Kaplaması (Geniş Ahşap Güverte)
    g.fillStyle = '#6f4e37';
    g.beginPath();
    g.moveTo(x - 58, bY - 2);
    g.lineTo(x + 62, bY - 7);
    g.lineTo(x + 52, bY + 14);
    g.lineTo(x - 48, bY + 16);
    g.closePath();
    g.fill();

    // Güverte ızgara çizgileri
    g.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    g.lineWidth = 1;
    for (let lx = -40; lx <= 50; lx += 15) {
        g.beginPath();
        g.moveTo(x + lx, bY + 2);
        g.lineTo(x + lx + 5, bY + 14);
        g.stroke();
    }

    // 4. Kıç Köşkü & Dümen Platformu (Quarterdeck & Helm)
    g.fillStyle = '#27272a';
    g.beginPath();
    g.roundRect(x - 62, bY - 14, 26, 20, 3);
    g.fill();
    g.strokeStyle = '#ffd166';
    g.lineWidth = 1.5;
    g.stroke();

    // Dümen Çarkı
    g.strokeStyle = '#d4a373';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x - 48, bY - 16, 5, 0, Math.PI * 2);
    g.moveTo(x - 48, bY - 22); g.lineTo(x - 48, bY - 10);
    g.moveTo(x - 54, bY - 16); g.lineTo(x - 42, bY - 16);
    g.stroke();

    // 5. Yan Bordadaki Toplar (Cannons)
    g.fillStyle = '#ffd166';
    for (let cx = -25; cx <= 35; cx += 20) {
        g.fillRect(x + cx, bY + 18, 6, 4);
    }

    // 6. Çift Direk & Lonca Sancakları (Twin Masts & Crimson Sails)
    // Ön Direk
    g.strokeStyle = '#3f2d20';
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(x + 24, bY + 4);
    g.lineTo(x + 24, bY - 48);
    g.stroke();

    // Ön Yelken
    g.fillStyle = '#991b1b';
    g.beginPath();
    g.moveTo(x + 24, bY - 46);
    g.quadraticCurveTo(x + 44, bY - 32, x + 24, bY - 18);
    g.lineTo(x + 12, bY - 24);
    g.closePath();
    g.fill();

    // Arka Direk
    g.strokeStyle = '#3f2d20';
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(x - 16, bY + 4);
    g.lineTo(x - 16, bY - 56);
    g.stroke();

    // Arka Yelken & Lonca Arması
    g.fillStyle = '#7f1d1d';
    g.beginPath();
    g.moveTo(x - 16, bY - 54);
    g.quadraticCurveTo(x + 8, bY - 38, x - 16, bY - 22);
    g.lineTo(x - 26, bY - 30);
    g.closePath();
    g.fill();
    g.font = '13px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.fillText('🏛️', x - 6, bY - 36);

    // Fenerler
    g.fillStyle = '#ffbe0b';
    g.beginPath();
    g.arc(x - 62, bY - 12, 3, 0, Math.PI * 2);
    g.arc(x + 72, bY - 6, 3, 0, Math.PI * 2);
    g.fill();

    // 7. Destroyer Başlığı
    g.font = 'bold 11px "Segoe UI", sans-serif';
    g.fillStyle = '#ffd166';
    g.textAlign = 'center';
    g.shadowColor = '#000';
    g.shadowBlur = 6;
    g.fillText(`🛡️ LONCA DESTROYER'İ • ⟨ ${guildName} ⟩`, x, bY + 36);
    g.shadowBlur = 0;

    // 8. LONCA ÜYELERİ GÜVERTEDE BALIK TUTUYOR!
    drawDestroyerCrew(g, x, bY, isLeader);
}

function drawDestroyerCrew(g, shipX, bY, isLeader) {
    const rawMembers = (activeGuild && activeGuild.members) ? activeGuild.members : [];
    const leaderName = (activeGuild && activeGuild.leader) ? activeGuild.leader : (player.name || 'Lider');

    // Mürettebat Üyeleri
    const dummyCrew = [
        { name: 'Kuzeyli Balıkçı', role: 'Subay', coatColor: '#3a86ff', hatColor: '#1d3557' },
        { name: 'Fırtına Reis', role: 'Kıdemli', coatColor: '#e07a5f', hatColor: '#3d405b' },
        { name: 'Deniz Gözcüsü Ege', role: 'Üye', coatColor: '#2ec4b6', hatColor: '#0b525b' },
        { name: 'Gümüşkanca', role: 'Çırak', coatColor: '#9d4edd', hatColor: '#3c096c' }
    ];

    const actualCrew = rawMembers.filter(m => !m.isPlayer && m.role !== 'Lider');
    const displayCrew = actualCrew.length > 0 ? actualCrew : dummyCrew;

    // A. DÜMENCİ (LONCA LİDERİ)
    // Eğer oyuncu liderse oyuncu bizzat dümendedir, değilse Lider NPC dümende durur
    if (!isLeader) {
        const hX = shipX - 48;
        const hY = bY - 16;
        drawCrewMemberSprite(g, hX, hY, '#ffb703', '#fb8500', `👑 ${leaderName} [Lider]`, false, true);
    } else {
        // Oyuncu dümende, üstünde kral tacı rozeti
        g.font = 'bold 10px "Segoe UI", sans-serif';
        g.fillStyle = '#ffd166';
        g.textAlign = 'center';
        g.fillText('👑 DÜMENDESİN (LİDER)', shipX - 48, bY - 32);
    }

    // B. GÜVERTEDEKİ BALIK TUTAN ÜYELER
    const deckSlots = [
        { dx: -28, dy: 10, rodAngle: 0.35, rodLen: 28 },
        { dx: 4, dy: 12, rodAngle: 0.45, rodLen: 30 },
        { dx: 36, dy: 8, rodAngle: 0.40, rodLen: 28 },
        { dx: 52, dy: -4, rodAngle: -0.35, rodLen: 26 }
    ];

    // Eğer oyuncu lider değilse, 0. slotta oyuncunun kendi olta atışı vardır, diğer slotlarda NPC'ler
    const startIndex = isLeader ? 0 : 1;
    for (let i = 0; i < deckSlots.length; i++) {
        const slot = deckSlots[i];
        const mX = shipX + slot.dx;
        const mY = bY + slot.dy;

        if (!isLeader && i === 0) {
            // Oyuncunun bulunduğu güverte noktası rozeti
            g.font = 'bold 10px "Segoe UI", sans-serif';
            g.fillStyle = '#4cc9f0';
            g.textAlign = 'center';
            g.fillText('⚓ SEN (GÜVERTE)', mX, mY - 26);
            continue;
        }

        const crewMember = displayCrew[(i - startIndex + displayCrew.length) % displayCrew.length];
        const cColor = crewMember.coatColor || '#3a86ff';
        const hColor = crewMember.hatColor || '#1d3557';
        const label = `${crewMember.name} [${crewMember.role || 'Üye'}]`;

        drawCrewMemberSprite(g, mX, mY, cColor, hColor, label, true, false, slot.rodAngle, slot.rodLen, i);
    }
}

function drawCrewMemberSprite(g, mx, my, coatColor, hatColor, nameLabel, isFishing = false, isHelm = false, rodAngle = 0.4, rodLen = 28, slotIndex = 0) {
    const bob = Math.sin(globalTime * 3.0 + slotIndex) * 1.5;
    const bodyY = my - 12 - bob;

    // Gövde (Ceket/Kıyafet)
    g.fillStyle = coatColor;
    g.beginPath();
    g.roundRect(mx - 5, bodyY, 10, 12, 3);
    g.fill();

    // Kafa
    g.fillStyle = '#fcd5b4';
    g.beginPath();
    g.arc(mx, bodyY - 5, 4.5, 0, Math.PI * 2);
    g.fill();

    // Şapka / Saç
    g.fillStyle = hatColor;
    g.beginPath();
    g.arc(mx, bodyY - 7, 5, Math.PI, Math.PI * 2);
    g.fill();

    // İsim Etiketi
    g.font = 'bold 9px "Segoe UI", sans-serif';
    g.fillStyle = isHelm ? '#ffd166' : '#e0e7ff';
    g.textAlign = 'center';
    g.shadowColor = '#000';
    g.shadowBlur = 4;
    g.fillText(nameLabel, mx, bodyY - 14);
    g.shadowBlur = 0;

    // Olta ve Suya İnen Misina (Balık Tutma Animasyonu)
    if (isFishing) {
        const rodEndX = mx + Math.cos(rodAngle) * rodLen;
        const rodEndY = bodyY + Math.sin(rodAngle) * rodLen;

        // Kamış
        g.strokeStyle = '#d4a373';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(mx + 2, bodyY + 4);
        g.lineTo(rodEndX, rodEndY);
        g.stroke();

        // Misina
        const splashY = my + 14 + (rodAngle > 0 ? 6 : -4);
        g.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(rodEndX, rodEndY);
        g.quadraticCurveTo(rodEndX + 4, (rodEndY + splashY) / 2, rodEndX + 2, splashY);
        g.stroke();

        // Şamandıra (Kırmızı/Beyaz Mantar)
        const floatWave = Math.sin(globalTime * 4 + slotIndex) * 1.5;
        g.fillStyle = '#ff595e';
        g.beginPath();
        g.arc(rodEndX + 2, splashY + floatWave, 2.5, 0, Math.PI * 2);
        g.fill();

        // Suda Mantar Halka Dalgası
        g.strokeStyle = 'rgba(255, 180, 190, 0.6)';
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(rodEndX + 2, splashY + floatWave + 1, 5, 2.5, 0, 0, Math.PI * 2);
        g.stroke();
    }
}

function drawSmoothCharacter(g, x, y, isPreview = false) {
    const costume = player.equipped.costume ? ITEMS[player.equipped.costume] : null;
    const shirtColor = costume ? costume.shirt : '#6c757d';
    const vestColor = costume ? costume.vest : '#495057';
    const pantsColor = costume ? costume.pants : '#2b2d42';
    const hatType = costume ? costume.hat : 'none';

    const isMoving = !isPreview && player.path.length > 0;
    const isBoatMode = !isPreview && (currentMapId === 'akdeniz' || currentMapId === 'kraken');
    const activeBoat = isBoatMode ? (currentMapId === 'kraken' ? (BOATS.boat_destroyer || BOATS.boat_boat) : (BOATS[player.activeBoatId] || BOATS.boat_boat)) : null;

    // Tekne modu: Karakter teknenin içinde oturur / sürer
    if (isBoatMode && activeBoat) {
        const boatWave = Math.sin(globalTime * 3.2 + x) * 2;
        const bY = y + boatWave;

        // Su köpüğü & dalga halkası
        g.fillStyle = 'rgba(255, 255, 255, 0.45)';
        g.beginPath();
        g.ellipse(x, bY + 4, 28, 12, 0, 0, Math.PI * 2);
        g.fill();

        // Tekne Gövdesi (Hull)
        if (activeBoat.id === 'boat_raft') {
            // Ahşap Sal
            g.fillStyle = activeBoat.hullColor || '#8c6239';
            for (let lx = -22; lx <= 18; lx += 8) {
                g.beginPath();
                g.roundRect(x + lx, bY - 8, 7, 24, 3);
                g.fill();
            }
            g.strokeStyle = activeBoat.accentColor || '#d4a373';
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(x - 24, bY); g.lineTo(x + 24, bY);
            g.moveTo(x - 24, bY + 8); g.lineTo(x + 24, bY + 8);
            g.stroke();
        } else if (activeBoat.id === 'boat_destroyer') {
            // DEVA SA LONCA DESTROYER'İ (Zırhlı Gövde, Pruva Mahmuzu, Çift Yelken & Güvertedeki Lonca Mürettebatı)
            drawGuildDestroyerWithCrew(g, x, y, bY);
            return;
        } else if (activeBoat.id === 'boat_minnkota') {
            // Minnkota'lı Balıkçı Teknesi (Koyu Çelik Gövde, Neon Çizgiler, Burunda Trolling Motoru)
            g.fillStyle = activeBoat.hullColor || '#0b1d3a';
            g.beginPath();
            g.moveTo(x - 28, bY - 4);
            g.lineTo(x + 30, bY - 8);
            g.lineTo(x + 24, bY + 13);
            g.lineTo(x - 22, bY + 13);
            g.closePath();
            g.fill();

            // Neon Turkuaz Kabin
            g.fillStyle = activeBoat.accentColor || '#00f5d4';
            g.beginPath();
            g.moveTo(x - 14, bY - 6);
            g.lineTo(x + 14, bY - 8);
            g.lineTo(x + 8, bY - 18);
            g.lineTo(x - 10, bY - 18);
            g.closePath();
            g.fill();

            // Burun Minn Kota Trolling Motoru ve GPS Çapası
            g.fillStyle = '#00f5d4';
            g.beginPath();
            g.arc(x + 28, bY - 12, 3.5, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#ffffff';
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(x + 28, bY - 12);
            g.lineTo(x + 28, bY);
            g.stroke();

            // Minnkota Tekne ismi rozeti
            g.font = 'bold 9.5px "Segoe UI", sans-serif';
            g.fillStyle = '#00f5d4';
            g.textAlign = 'center';
            g.fillText('⚡ ' + activeBoat.name, x, bY + 19);
        } else {
            // Tekne / Yat / Sürat Teknesi
            g.fillStyle = activeBoat.hullColor || '#457b9d';
            g.beginPath();
            g.moveTo(x - 26, bY - 4);
            g.lineTo(x + 28, bY - 8);
            g.lineTo(x + 22, bY + 12);
            g.lineTo(x - 20, bY + 12);
            g.closePath();
            g.fill();

            // Detay / Çizgi / Kabin
            g.fillStyle = activeBoat.accentColor || '#f1faee';
            g.beginPath();
            g.moveTo(x - 12, bY - 6);
            g.lineTo(x + 16, bY - 8);
            g.lineTo(x + 10, bY - 18);
            g.lineTo(x - 8, bY - 18);
            g.closePath();
            g.fill();

            // Tekne ismi rozeti
            g.font = 'bold 9.5px "Segoe UI", sans-serif';
            g.fillStyle = '#ffffff';
            g.textAlign = 'center';
            g.fillText(activeBoat.name, x, bY + 19);
        }
    }

    const bob = isBoatMode
        ? Math.sin(globalTime * 3.2 + x) * 2
        : (isMoving ? Math.abs(Math.sin(player.walkCycle * 9)) * 4 : Math.sin(globalTime * 2.5) * 1.2);
    const stride = (isMoving && !isBoatMode) ? Math.sin(player.walkCycle * 9) * 5 : 0;

    if (!isBoatMode) {
        g.fillStyle = 'rgba(0, 0, 0, 0.32)';
        g.beginPath();
        g.ellipse(x, y, 14, 7, 0, 0, Math.PI * 2);
        g.fill();

        g.strokeStyle = pantsColor;
        g.lineWidth = 6;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - 5, y - 14);
        g.lineTo(x - 5 + stride * 0.5, y - 3 + stride * 0.4);
        g.moveTo(x + 5, y - 14);
        g.lineTo(x + 5 - stride * 0.5, y - 3 - stride * 0.4);
        g.stroke();
    }

    const bodyY = (isBoatMode ? (y - 18 - bob) : (y - 28 - bob));

    // KRALİYET MUHAFIZI KOSTÜMÜ: Görkemli Pelerin, Altın Zırh Omuzlukları ve Parlama Aurası
    if (costume && (costume.id === 'costume_royal_guard' || costume.isRoyal)) {
        g.save();
        // 1. Karakterin arkasındaki kraliyet safiri pelerin
        g.fillStyle = '#03045e';
        g.beginPath();
        g.moveTo(x - 10, bodyY + 3);
        g.lineTo(x - 14, bodyY + 22);
        g.lineTo(x + 14, bodyY + 22);
        g.lineTo(x + 10, bodyY + 3);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.5;
        g.stroke();

        // 2. Yerde dönen parıldayan kraliyet halesi (Altın & Safir)
        if (!isPreview) {
            const auraT = globalTime * 3.5;
            const pulse = Math.sin(auraT * 1.5) * 2.5;
            g.strokeStyle = 'rgba(255, 209, 102, 0.5)';
            g.lineWidth = 2.2;
            g.beginPath();
            g.ellipse(x, y + 1, 20 + pulse, 9 + pulse * 0.4, 0, 0, Math.PI * 2);
            g.stroke();

            g.strokeStyle = 'rgba(0, 245, 212, 0.65)';
            g.lineWidth = 1.4;
            g.beginPath();
            g.ellipse(x, y + 1, 14 - pulse * 0.4, 6 - pulse * 0.2, 0, 0, Math.PI * 2);
            g.stroke();

            // Karakter etrafında süzülen 4 parıldayan yıldız
            for (let i = 0; i < 4; i++) {
                const ang = auraT + (i * Math.PI / 2);
                const rx = 18 + Math.sin(auraT * 2 + i) * 3;
                const ry = 9 + Math.cos(auraT * 2 + i) * 2;
                const sx = x + Math.cos(ang) * rx;
                const sy = (bodyY + 6) + Math.sin(ang) * ry;
                const col = (i % 2 === 0) ? '#ffd166' : '#00f5d4';
                drawSilkroadSparkle(g, sx, sy, 3.2 + Math.sin(auraT * 3 + i) * 1.2, col);
            }

            // Omuzlardan yükselen altın ışıltılar
            const s1Y = (bodyY - 4) - ((globalTime * 24) % 28);
            const s1X = x - 7 + Math.sin(globalTime * 5) * 3;
            drawSilkroadSparkle(g, s1X, s1Y, 2.2, '#ffffff');

            const s2Y = (bodyY - 2) - (((globalTime + 1.2) * 22) % 28);
            const s2X = x + 7 + Math.cos(globalTime * 4) * 3;
            drawSilkroadSparkle(g, s2X, s2Y, 2.0, '#ffd166');
        }
        g.restore();
    }

    g.fillStyle = shirtColor;
    g.beginPath();
    g.roundRect(x - 11, bodyY, 22, 18, 6);
    g.fill();

    g.fillStyle = vestColor;
    g.beginPath();
    g.roundRect(x - 9, bodyY + 1, 6, 16, 3);
    g.roundRect(x + 3, bodyY + 1, 6, 16, 3);
    g.fill();

    // Kraliyet Muhafızı Altın Omuzlukları (Pauldrons)
    if (costume && (costume.id === 'costume_royal_guard' || costume.isRoyal)) {
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(x - 11, bodyY + 4, 3.5, 0, Math.PI * 2);
        g.arc(x + 11, bodyY + 4, 3.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#d4a373';
        g.lineWidth = 1;
        g.stroke();
    }

    const headY = bodyY - 12;
    g.fillStyle = '#ffcdb2';
    g.beginPath();
    g.arc(x, headY, 10.5, 0, Math.PI * 2);
    g.fill();

    const lookRight = isPreview ? true : (player.dirX >= player.dirY);
    const eyeOffsetX = lookRight ? 2.5 : -2.5;
    g.fillStyle = '#1d1e2c';
    g.beginPath();
    g.arc(x - 3.5 + eyeOffsetX, headY + 1, 1.8, 0, Math.PI * 2);
    g.arc(x + 3.5 + eyeOffsetX, headY + 1, 1.8, 0, Math.PI * 2);
    g.fill();

    if (hatType === 'straw') {
        g.fillStyle = '#e9c46a';
        g.beginPath();
        g.ellipse(x, headY - 6, 16, 5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#f4a261';
        g.beginPath();
        g.arc(x, headY - 7, 9.5, Math.PI, 0);
        g.fill();
        g.strokeStyle = '#e63946';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x - 9, headY - 7);
        g.lineTo(x + 9, headY - 7);
        g.stroke();
    } else if (hatType === 'pirate') {
        g.fillStyle = '#1d1e2c';
        g.beginPath();
        g.moveTo(x - 16, headY - 5);
        g.quadraticCurveTo(x, headY - 19, x + 16, headY - 5);
        g.closePath();
        g.fill();
        g.fillStyle = '#ffbe0b';
        g.beginPath();
        g.arc(x, headY - 9, 3, 0, Math.PI * 2);
        g.fill();
    } else if (hatType === 'hood') {
        g.strokeStyle = '#cbf3f0';
        g.lineWidth = 4.5;
        g.beginPath();
        g.arc(x, headY, 11.5, Math.PI * 0.8, Math.PI * 0.2);
        g.stroke();
    } else if (hatType === 'sailor') {
        // Deniz Kurdu Beresi / Kepi
        g.fillStyle = '#1d3557';
        g.beginPath();
        g.ellipse(x, headY - 6, 13, 5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#f1faee';
        g.beginPath();
        g.arc(x, headY - 7, 8, Math.PI, 0);
        g.fill();
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(x, headY - 7, 2.5, 0, Math.PI * 2);
        g.fill();
    } else if (hatType === 'bandana') {
        // Karayip Yağmacısı Korsan Bandanası
        g.fillStyle = '#9d0208';
        g.beginPath();
        g.arc(x, headY - 3, 11, Math.PI, 0);
        g.fill();
        g.fillStyle = '#ba181b';
        g.fillRect(x - 11, headY - 4, 22, 4);
        // Arkadan sarkan bandana ucu
        g.beginPath();
        g.moveTo(x + 9, headY - 2);
        g.lineTo(x + 14, headY + 6);
        g.lineTo(x + 11, headY + 7);
        g.closePath();
        g.fill();
    } else if (hatType === 'diving') {
        // Derin Su Dalgıcı Pirinç Miğferi
        g.fillStyle = '#d4a373';
        g.beginPath();
        g.arc(x, headY - 1, 11.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#b08968';
        g.lineWidth = 2;
        g.stroke();
        // Cam gözetleme lumbozu
        g.fillStyle = '#a2d2ff';
        g.beginPath();
        g.arc(x + (lookRight ? 3 : -3), headY - 1, 4.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#495057';
        g.lineWidth = 1.2;
        g.stroke();
    } else if (hatType === 'feather_pirate') {
        // Barbaros Korsan Zırhı / Tüylü Kaptan Tricornu
        g.fillStyle = '#03071e';
        g.beginPath();
        g.moveTo(x - 17, headY - 5);
        g.quadraticCurveTo(x, headY - 20, x + 17, headY - 5);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffb703';
        g.lineWidth = 2;
        g.stroke();
        // Gösterişli Kızıl Tüy
        g.strokeStyle = '#d90429';
        g.lineWidth = 3.5;
        g.beginPath();
        g.moveTo(x - 4, headY - 16);
        g.quadraticCurveTo(x - 14, headY - 24, x - 18, headY - 16);
        g.stroke();
    } else if (hatType === 'bucket') {
        // Usta Olta Balıkçısı Şapkası
        g.fillStyle = '#606c38';
        g.beginPath();
        g.ellipse(x, headY - 5, 15, 5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#283618';
        g.beginPath();
        g.arc(x, headY - 6, 9, Math.PI, 0);
        g.fill();
    } else if (hatType === 'royal_helm') {
        // Görkemli Kraliyet Muhafızı Altın Tacı / Miğferi
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(x, headY - 4, 11, Math.PI, 0);
        g.fill();
        // 3 Taç ucu
        g.beginPath();
        g.moveTo(x - 10, headY - 4);
        g.lineTo(x - 10, headY - 14);
        g.lineTo(x - 5, headY - 7);
        g.lineTo(x, headY - 17);
        g.lineTo(x + 5, headY - 7);
        g.lineTo(x + 10, headY - 14);
        g.lineTo(x + 10, headY - 4);
        g.closePath();
        g.fill();
        g.strokeStyle = '#d4a373';
        g.lineWidth = 1.5;
        g.stroke();
        // Ortadaki parıldayan safir mücevher
        g.fillStyle = '#00f5d4';
        g.beginPath();
        g.arc(x, headY - 8, 2.5, 0, Math.PI * 2);
        g.fill();
    } else {
        g.fillStyle = '#582f0e';
        g.beginPath();
        g.arc(x, headY - 3, 10.5, Math.PI, 0);
        g.fill();
    }

    const rodItem = player.equipped.rod ? ITEMS[player.equipped.rod] : null;
    if (rodItem) {
        const handX = x + 9;
        const handY = bodyY + 9;
        const tipX = handX + 22;
        const tipY = handY - 24;

        g.strokeStyle = rodItem.rodColor;
        g.lineWidth = 3.2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(handX - 2, handY + 3);
        g.quadraticCurveTo(handX + 8, handY - 12, tipX, tipY);
        g.stroke();

        g.fillStyle = rodItem.reelColor;
        g.beginPath();
        g.arc(handX + 4, handY - 2, 3.2, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = rodItem.rodTip;
        g.beginPath();
        g.arc(tipX, tipY, 2.5, 0, Math.PI * 2);
        g.fill();

        const eqRodEntry = getEquippedRodEntry();
        const ench = eqRodEntry ? getEntryEnchants(eqRodEntry) : player.rodEnchants[rodItem.id];
        if (ench && ench.count > 0) {
            g.strokeStyle = 'rgba(255, 190, 11, 0.65)';
            g.lineWidth = 1.5;
            g.beginPath();
            g.arc(tipX, tipY, 4.5 + Math.sin(globalTime * 6) * 1.5, 0, Math.PI * 2);
            g.stroke();
        }

        if (rodItem.isSOS) {
            // Silkroad Online SOS (Seal of Star) Parlama ve Yıldız Aura Efekti
            g.save();
            // 1. Neon Aura Çizimi (Camgöbeği & Altın Işıma)
            g.strokeStyle = 'rgba(0, 245, 212, 0.45)';
            g.lineWidth = 7.5;
            g.lineCap = 'round';
            g.beginPath();
            g.moveTo(handX - 2, handY + 3);
            g.quadraticCurveTo(handX + 8, handY - 12, tipX, tipY);
            g.stroke();

            g.strokeStyle = 'rgba(255, 209, 102, 0.75)';
            g.lineWidth = 4.2;
            g.stroke();

            // 2. Olta ucu etrafında dönen SOS yıldızları
            const t = globalTime * 4.2;
            for (let i = 0; i < 3; i++) {
                const ang = t + (i * Math.PI * 2 / 3);
                const dist = 6 + Math.sin(t * 1.5 + i) * 2.5;
                const sx = tipX + Math.cos(ang) * dist;
                const sy = tipY + Math.sin(ang) * (dist * 0.75);
                drawSilkroadSparkle(g, sx, sy, 3.6 + Math.sin(t * 3 + i) * 1.2, i % 2 === 0 ? '#ffd166' : '#00f5d4');
            }

            // 3. Olta gövdesi üzerinde süzülen 2 adet parıldayan yıldız
            const prog1 = (Math.sin(globalTime * 3) + 1) / 2;
            const midX1 = (handX - 2) * (1 - prog1) + tipX * prog1;
            const midY1 = (handY + 3) * (1 - prog1) + tipY * prog1 - (1 - 4 * Math.pow(prog1 - 0.5, 2)) * 6;
            drawSilkroadSparkle(g, midX1, midY1, 2.8, '#ffffff');

            const prog2 = (Math.cos(globalTime * 2.5) + 1) / 2;
            const midX2 = (handX - 2) * (1 - prog2) + tipX * prog2;
            const midY2 = (handY + 3) * (1 - prog2) + tipY * prog2 + (1 - 4 * Math.pow(prog2 - 0.5, 2)) * 4;
            drawSilkroadSparkle(g, midX2, midY2, 2.2, '#00f5d4');

            g.restore();
        }

        if (isPreview || fishing.state === 'IDLE') {
            g.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(tipX, tipY);
            g.lineTo(tipX, tipY + 14);
            g.stroke();
        }
    }

    // Karakter Adı ve Konuşma Baloncuğu (Sohbet)
    if (!isPreview) {
        const charName = player.name || 'Balıkçı';
        const lvTag = `Lv.${player.level}`;

        g.save();
        g.font = 'bold 11px "Segoe UI", sans-serif';
        const lvW = g.measureText(lvTag).width;
        const nameW = g.measureText(charName).width;
        const tagW = lvW + nameW + 16;
        const tagH = 18;
        const tagX = x - tagW / 2;
        const tagY = headY - 24;

        // İsimlik zemin kutusu
        g.fillStyle = 'rgba(10, 16, 26, 0.85)';
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.2;
        g.beginPath();
        g.roundRect(tagX, tagY, tagW, tagH, 9);
        g.fill();
        g.stroke();

        // Seviye (Altın sarısı)
        g.shadowColor = 'rgba(0, 0, 0, 0.9)';
        g.shadowBlur = 4;
        g.fillStyle = '#ffd166';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(lvTag, tagX + 7, tagY + tagH / 2);

        // İsim (Beyaz)
        g.fillStyle = '#ffffff';
        g.fillText(charName, tagX + 7 + lvW + 4, tagY + tagH / 2);

        let topAnchorY = tagY;

        // Lonca İsmi (Adımızın Hemen Üstünde Koyu Sarı Renk)
        if (player.guildName) {
            const gText = `⟨ ${player.guildName} ⟩`;
            g.font = 'bold 10.5px "Segoe UI", sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillStyle = '#e5a93c'; // Koyu Sarı (Rich Warm Amber/Gold)
            g.shadowColor = 'rgba(0, 0, 0, 0.95)';
            g.shadowBlur = 4;
            g.fillText(gText, x, tagY - 9);
            topAnchorY = tagY - 17;
        }

        // Konuşma Baloncuğu (Eğer son zamanlarda chat'e yazdıysa)
        if (player.chatBubble && player.chatBubble.timer > 0) {
            const rawText = player.chatBubble.text;
            g.font = '600 11.5px "Segoe UI", sans-serif';

            // Metni kelimelere bölerek satırlara ayır
            const words = rawText.split(' ');
            const lines = [];
            let curLine = '';
            words.forEach(w => {
                if ((curLine + ' ' + w).trim().length <= 24) {
                    curLine = (curLine + ' ' + w).trim();
                } else {
                    if (curLine) lines.push(curLine);
                    curLine = w;
                }
            });
            if (curLine) lines.push(curLine);
            if (lines.length > 3) lines.length = 3;

            let maxLineWidth = 0;
            lines.forEach(l => {
                const lw = g.measureText(l).width;
                if (lw > maxLineWidth) maxLineWidth = lw;
            });

            const padX = 10;
            const padY = 6;
            const lineH = 15;
            const bubbleW = Math.max(54, maxLineWidth + padX * 2);
            const bubbleH = lines.length * lineH + padY * 2;
            const bubbleX = x - bubbleW / 2;
            const bubbleY = topAnchorY - bubbleH - 7;

            // Balon gövdesi
            g.fillStyle = '#f8f9fa';
            g.strokeStyle = '#141a26';
            g.lineWidth = 1.5;
            g.beginPath();
            g.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 8);
            g.fill();
            g.stroke();

            // Balon ucu (aşağı isimliğe doğru)
            g.beginPath();
            g.moveTo(x - 5, bubbleY + bubbleH);
            g.lineTo(x, bubbleY + bubbleH + 6);
            g.lineTo(x + 5, bubbleY + bubbleH);
            g.closePath();
            g.fill();
            g.stroke();

            // Balon metni
            g.fillStyle = '#141a26';
            g.textAlign = 'center';
            g.textBaseline = 'top';
            lines.forEach((l, idx) => {
                g.fillText(l, x, bubbleY + padY + idx * lineH);
            });
        }

        g.restore();
    }
}

function drawNPCOrInteractable(g, inter, sx, sy) {
    if (inter.type === 'teleport') {
        const pulse = Math.sin(globalTime * 3.5) * 3;
        g.fillStyle = 'rgba(76, 201, 240, 0.25)';
        g.beginPath();
        g.ellipse(sx, sy, 24, 12, 0, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = '#495057';
        g.beginPath();
        g.ellipse(sx, sy, 18, 9, 0, 0, Math.PI * 2);
        g.fill();

        const grad = g.createLinearGradient(sx, sy - 52, sx, sy);
        grad.addColorStop(0, '#4cc9f0');
        grad.addColorStop(0.5, '#7209b7');
        grad.addColorStop(1, '#2b2d42');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(sx - 11, sy - 2);
        g.lineTo(sx - 8, sy - 42 + pulse * 0.4);
        g.lineTo(sx, sy - 54 + pulse * 0.4);
        g.lineTo(sx + 8, sy - 42 + pulse * 0.4);
        g.lineTo(sx + 11, sy - 2);
        g.closePath();
        g.fill();

        g.strokeStyle = '#90e0ef';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(sx, sy - 26 + pulse * 0.3, 5, 0, Math.PI * 2);
        g.stroke();

        drawFloatingLabel(g, sx, sy - 64, `💠 ${inter.name}`, null, '#4cc9f0');
        return;
    }

    if (inter.type === 'anvil') {
        const pulse = Math.sin(globalTime * 3);
        const glowAlpha = 0.35 + pulse * 0.15;

        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.beginPath();
        g.ellipse(sx, sy + 3, 28, 14, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Büyülü Işıma Halkası (Aura)
        const auraGrad = g.createRadialGradient(sx, sy - 8, 4, sx, sy - 8, 34);
        auraGrad.addColorStop(0, `rgba(157, 78, 221, ${glowAlpha * 0.7})`);
        auraGrad.addColorStop(0.5, `rgba(76, 201, 240, ${glowAlpha * 0.35})`);
        auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        g.fillStyle = auraGrad;
        g.beginPath();
        g.ellipse(sx, sy - 6, 36, 18, 0, 0, Math.PI * 2);
        g.fill();

        // 3. Katmanlı Rünlü Taş Sunak / Kaide (Obsidyen & Granit)
        // Alt Basamak
        g.fillStyle = '#1c1f26';
        g.strokeStyle = '#2b303c';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(sx - 26, sy);
        g.lineTo(sx, sy - 13);
        g.lineTo(sx + 26, sy);
        g.lineTo(sx, sy + 13);
        g.closePath();
        g.fill();
        g.stroke();

        // Üst Kaide
        g.fillStyle = '#262a36';
        g.strokeStyle = '#434a5d';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(sx - 20, sy - 7);
        g.lineTo(sx, sy - 17);
        g.lineTo(sx + 20, sy - 7);
        g.lineTo(sx, sy + 3);
        g.closePath();
        g.fill();
        g.stroke();

        // Kaide Üstündeki Parlayan Büyülü Rünler
        g.fillStyle = `rgba(199, 125, 255, ${0.5 + pulse * 0.4})`;
        g.shadowColor = '#c77dff';
        g.shadowBlur = 6;
        g.beginPath();
        g.arc(sx - 12, sy - 7, 2, 0, Math.PI * 2);
        g.arc(sx + 12, sy - 7, 2, 0, Math.PI * 2);
        g.arc(sx, sy - 14, 2, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;

        // 4. Görkemli Efsunlu Örs (Mighty Forged Anvil)
        const anvilBaseY = sy - 12;
        // Örs Tabanı
        g.fillStyle = '#2b2d42';
        g.fillRect(sx - 13, anvilBaseY - 5, 26, 6);

        // Örs Bel / Gövde (Orta Kolon)
        g.fillStyle = '#3a3e59';
        g.fillRect(sx - 8, anvilBaseY - 14, 16, 10);

        // Örs Üst Bloğu & Boynuzları
        g.fillStyle = '#4a4e69';
        g.strokeStyle = '#6c757d';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx - 24, anvilBaseY - 22); // Sol sivri boynuz ucu
        g.lineTo(sx - 8, anvilBaseY - 16);  // Boynuz altı eğimi
        g.lineTo(sx + 16, anvilBaseY - 16); // Sağ gövde altı
        g.lineTo(sx + 18, anvilBaseY - 19); // Sağ basamak
        g.lineTo(sx + 14, anvilBaseY - 24); // Sağ arka
        g.lineTo(sx - 16, anvilBaseY - 24); // Üst yüzey arkası
        g.closePath();
        g.fill();
        g.stroke();

        // Örsün Üst Düz Yüzeyi (Gleaming Steel Face)
        g.fillStyle = '#8d99ae';
        g.beginPath();
        g.moveTo(sx - 22, anvilBaseY - 23);
        g.lineTo(sx + 14, anvilBaseY - 23);
        g.lineTo(sx + 16, anvilBaseY - 25);
        g.lineTo(sx - 20, anvilBaseY - 25);
        g.closePath();
        g.fill();

        // Örs Üzerindeki Efsunlu Çatlaklar / Işıltı Damarları
        g.strokeStyle = `rgba(0, 245, 212, ${0.6 + pulse * 0.35})`;
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(sx - 10, anvilBaseY - 21);
        g.lineTo(sx - 2, anvilBaseY - 18);
        g.lineTo(sx + 6, anvilBaseY - 22);
        g.stroke();

        // 5. Örsün Yanında Duran Mitolojik Efsunlu Çekiç
        g.save();
        g.translate(sx + 10, anvilBaseY - 20);
        g.rotate(0.35 + pulse * 0.04);
        // Sap
        g.fillStyle = '#8b5a2b';
        g.fillRect(-2, -18, 4, 22);
        // Çekiç Başı
        g.fillStyle = '#e0e1dd';
        g.strokeStyle = '#c77dff';
        g.lineWidth = 1.2;
        g.fillRect(-8, -26, 16, 9);
        g.strokeRect(-8, -26, 16, 9);
        // Çekiç Işıltısı
        g.fillStyle = `rgba(199, 125, 255, ${0.6 + pulse * 0.3})`;
        g.fillRect(-3, -24, 6, 5);
        g.restore();

        // 6. Havaya Yükselen Efsun Kıvılcımları
        for (let i = 0; i < 4; i++) {
            const sparkOffset = ((globalTime * 30 + i * 22) % 36);
            const sparkX = sx - 10 + (i * 7) + Math.sin(globalTime * 3 + i) * 4;
            const sparkY = anvilBaseY - 22 - sparkOffset;
            const sparkAlpha = Math.max(0, 1 - (sparkOffset / 36));
            g.fillStyle = i % 2 === 0 ? `rgba(199, 125, 255, ${sparkAlpha})` : `rgba(0, 245, 212, ${sparkAlpha})`;
            g.beginPath();
            g.arc(sparkX, sparkY, 1.3, 0, Math.PI * 2);
            g.fill();
        }

        drawFloatingLabel(g, sx, sy - 54, `🔨 ${inter.name}`, null, '#c77dff');
        return;
    }

    g.fillStyle = 'rgba(0, 0, 0, 0.32)';
    g.beginPath();
    g.ellipse(sx, sy, 14, 7, 0, 0, Math.PI * 2);
    g.fill();

    const bob = Math.sin(globalTime * 2 + inter.x) * 1.2;
    const bodyY = sy - 28 - bob;

    g.fillStyle = inter.coatColor || '#3a86ff';
    g.beginPath();
    g.roundRect(sx - 11, bodyY, 22, 20, 6);
    g.fill();

    const headY = bodyY - 11;
    g.fillStyle = '#ffcdb2';
    g.beginPath();
    g.arc(sx, headY, 10, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#1d1e2c';
    g.beginPath();
    g.arc(sx - 3, headY + 1, 1.6, 0, Math.PI * 2);
    g.arc(sx + 3, headY + 1, 1.6, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = inter.hatColor || '#1d3557';
    g.beginPath();
    g.arc(sx, headY - 3, 10.5, Math.PI, 0);
    g.fill();

    // Muhtar Ahmet için baş üstü Görev İkonu (Altın Parıltılı)
    if (inter.type === 'headman') {
        const questBob = Math.sin(globalTime * 3.5) * 3;
        g.save();
        g.font = 'bold 16px "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.shadowColor = '#ffd166';
        g.shadowBlur = 10;
        g.fillText('📜', sx, headY - 14 - questBob);
        g.restore();
    } else if (inter.type === 'guild_guard') {
        const guardBob = Math.sin(globalTime * 3.5) * 2;
        g.save();
        g.font = 'bold 15px "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.shadowColor = '#4cc9f0';
        g.shadowBlur = 8;
        g.fillText('🛡️', sx, headY - 14 - guardBob);
        g.restore();
    } else if (inter.type === 'tailor') {
        const tailorBob = Math.sin(globalTime * 3.5) * 2;
        g.save();
        g.font = 'bold 15px "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.shadowColor = '#ffd166';
        g.shadowBlur = 8;
        g.fillText('🧵', sx, headY - 14 - tailorBob);
        g.restore();
    }

    drawFloatingLabel(g, sx, sy - 54, inter.name, null, '#ffd166');
}

function drawFloatingLabel(g, sx, sy, title, subtitle, color) {
    g.save();
    g.font = 'bold 11px "Segoe UI", sans-serif';
    const hasSub = !!(subtitle && subtitle.trim().length > 0);
    const titleW = g.measureText(title).width;
    const subW = hasSub ? g.measureText(subtitle).width : 0;
    const w = Math.max(titleW, subW) + 14;
    const h = hasSub ? 28 : 17;
    const boxY = hasSub ? (sy - 22) : (sy - 15);

    g.fillStyle = 'rgba(10, 16, 26, 0.88)';
    g.strokeStyle = color;
    g.lineWidth = 1.2;
    g.beginPath();
    g.roundRect(sx - w / 2, boxY, w, h, 5);
    g.fill();
    g.stroke();

    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    if (hasSub) {
        g.fillText(title, sx, boxY + 8);
        g.font = '9px "Segoe UI", sans-serif';
        g.fillStyle = '#ced4da';
        g.fillText(subtitle, sx, boxY + 20);
    } else {
        g.fillText(title, sx, boxY + h / 2);
    }
    g.restore();
}

function drawIsoTile(g, sx, sy, topColor, strokeColor, sideColor = null, depth = 0) {
    const hw = TILE_W / 2;
    const hh = TILE_H / 2;

    if (sideColor && depth > 0) {
        g.fillStyle = sideColor;
        g.beginPath();
        g.moveTo(sx - hw, sy - depth);
        g.lineTo(sx, sy + hh - depth);
        g.lineTo(sx + hw, sy - depth);
        g.lineTo(sx + hw, sy);
        g.lineTo(sx, sy + hh);
        g.lineTo(sx - hw, sy);
        g.closePath();
        g.fill();
    }

    g.fillStyle = topColor;
    g.beginPath();
    g.moveTo(sx, sy - hh - depth);
    g.lineTo(sx + hw, sy - depth);
    g.lineTo(sx, sy + hh - depth);
    g.lineTo(sx - hw, sy - depth);
    g.closePath();
    g.fill();

    if (strokeColor) {
        g.strokeStyle = strokeColor;
        g.lineWidth = 0.6;
        g.stroke();
    }
}

function drawProp(g, prop, sx, sy) {
    if (prop.type === 'palm') {
        const sway = Math.sin(globalTime * 1.8 + prop.x) * 3;
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.ellipse(sx, sy, 18, 8, 0, 0, Math.PI * 2);
        g.fill();

        g.strokeStyle = '#8c6239';
        g.lineWidth = 8;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(sx, sy);
        g.quadraticCurveTo(sx + 8, sy - 28, sx + 10 + sway * 0.5, sy - 54);
        g.stroke();

        const tx = sx + 10 + sway * 0.5;
        const ty = sy - 54;
        const angles = [-2.4, -1.6, -0.7, 0.2, 1.0, 2.0];
        angles.forEach(a => {
            g.fillStyle = '#2b9348';
            g.beginPath();
            g.ellipse(tx + Math.cos(a) * 16, ty + Math.sin(a) * 10, 18, 5, a * 0.5, 0, Math.PI * 2);
            g.fill();
        });
    } else if (prop.type === 'oak') {
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.beginPath();
        g.ellipse(sx, sy, 22, 10, 0, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = '#6c584c';
        g.fillRect(sx - 5, sy - 32, 10, 32);

        g.fillStyle = '#2d6a4f';
        g.beginPath();
        g.arc(sx - 12, sy - 38, 16, 0, Math.PI * 2);
        g.arc(sx + 12, sy - 38, 16, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = '#40916c';
        g.beginPath();
        g.arc(sx, sy - 48, 19, 0, Math.PI * 2);
        g.fill();
    } else if (prop.type === 'fountain') {
        g.fillStyle = '#adb5bd';
        g.beginPath();
        g.ellipse(sx, sy, 34, 17, 0, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = '#0096c7';
        g.beginPath();
        g.ellipse(sx, sy - 3, 28, 13, 0, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = '#ced4da';
        g.fillRect(sx - 6, sy - 28, 12, 24);

        const splash = Math.sin(globalTime * 6) * 2;
        g.strokeStyle = '#caf0f8';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(sx, sy - 28);
        g.quadraticCurveTo(sx - 12, sy - 40 - splash, sx - 16, sy - 10);
        g.moveTo(sx, sy - 28);
        g.quadraticCurveTo(sx + 12, sy - 40 - splash, sx + 16, sy - 10);
        g.stroke();
    } else if (prop.type === 'lantern') {
        g.fillStyle = '#2b2d42';
        g.fillRect(sx - 2, sy - 34, 4, 34);
        g.fillStyle = 'rgba(255, 190, 11, 0.25)';
        g.beginPath();
        g.arc(sx, sy - 36, 14, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ffbe0b';
        g.beginPath();
        g.arc(sx, sy - 36, 5, 0, Math.PI * 2);
        g.fill();
    } else if (prop.type === 'reed') {
        g.strokeStyle = '#52b788';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(sx - 4, sy); g.lineTo(sx - 6, sy - 18);
        g.moveTo(sx, sy);     g.lineTo(sx + 1, sy - 22);
        g.moveTo(sx + 4, sy); g.lineTo(sx + 6, sy - 16);
        g.stroke();
    } else if (prop.type === 'rock') {
        g.fillStyle = '#6c757d';
        g.beginPath();
        g.ellipse(sx, sy - 4, 12, 8, 0, 0, Math.PI * 2);
        g.fill();
    } else if (prop.type === 'starfish') {
        g.fillStyle = '#ff6b6b';
        g.beginPath();
        g.arc(sx, sy - 3, 4.5, 0, Math.PI * 2);
        g.fill();
    } else if (prop.type === 'shell') {
        g.fillStyle = '#f8edeb';
        g.beginPath();
        g.arc(sx, sy - 3, 4, 0, Math.PI * 2);
        g.fill();
    } else if (prop.type === 'guild_temple') {
        const pulse = Math.sin(globalTime * 3);

        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.beginPath();
        g.ellipse(sx, sy + 6, 58, 28, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Mermer Sunak / Kaide Basamakları (3 Katmanlı Podium)
        // Alt Basamak
        g.fillStyle = '#b0b7c3';
        g.beginPath();
        g.moveTo(sx - 52, sy);
        g.lineTo(sx, sy - 26);
        g.lineTo(sx + 52, sy);
        g.lineTo(sx, sy + 26);
        g.closePath();
        g.fill();
        g.strokeStyle = '#8d99ae';
        g.lineWidth = 1.5;
        g.stroke();

        // Orta Basamak
        g.fillStyle = '#d5dbe5';
        g.beginPath();
        g.moveTo(sx - 44, sy - 4);
        g.lineTo(sx, sy - 26);
        g.lineTo(sx + 44, sy - 4);
        g.lineTo(sx, sy + 18);
        g.closePath();
        g.fill();
        g.stroke();

        // Üst Mermer Platform
        g.fillStyle = '#f8f9fa';
        g.beginPath();
        g.moveTo(sx - 38, sy - 8);
        g.lineTo(sx, sy - 27);
        g.lineTo(sx + 38, sy - 8);
        g.lineTo(sx, sy + 11);
        g.closePath();
        g.fill();

        // 3. İç Tapınak Duvarı & Derin Portal Kapı
        const wallBaseY = sy - 12;
        g.fillStyle = '#1b2234';
        g.beginPath();
        g.moveTo(sx - 28, wallBaseY);
        g.lineTo(sx + 28, wallBaseY);
        g.lineTo(sx + 28, wallBaseY - 42);
        g.lineTo(sx - 28, wallBaseY - 42);
        g.closePath();
        g.fill();

        // Büyülü Portal Işıltısı (Mor / Altın Aura)
        const portalGrad = g.createRadialGradient(sx, wallBaseY - 18, 2, sx, wallBaseY - 18, 20);
        portalGrad.addColorStop(0, `rgba(181, 23, 158, ${0.75 + pulse * 0.2})`);
        portalGrad.addColorStop(0.6, `rgba(114, 9, 183, ${0.4 + pulse * 0.15})`);
        portalGrad.addColorStop(1, 'rgba(10, 14, 24, 0.95)');
        g.fillStyle = portalGrad;
        g.beginPath();
        g.arc(sx, wallBaseY - 18, 14, Math.PI, 0);
        g.lineTo(sx + 14, wallBaseY);
        g.lineTo(sx - 14, wallBaseY);
        g.closePath();
        g.fill();

        // 4. 4 Adet Klasik Mermer Sütun (Columns)
        const colX = [-26, -9, 9, 26];
        colX.forEach(cx => {
            // Sütun gölgesi
            g.fillStyle = 'rgba(0,0,0,0.2)';
            g.fillRect(sx + cx - 3.5, wallBaseY - 38, 7, 38);
            // Mermer sütun
            g.fillStyle = '#f1faee';
            g.fillRect(sx + cx - 3, wallBaseY - 40, 6, 40);
            // Sütun başlığı (Capital)
            g.fillStyle = '#ffd166';
            g.fillRect(sx + cx - 4.5, wallBaseY - 42, 9, 3);
            // Sütun tabanı (Base)
            g.fillRect(sx + cx - 4.5, wallBaseY - 2, 9, 3);
        });

        // 5. Üst Çatı & Üçgen Alınlık (Pediment / Fronton)
        const roofBaseY = wallBaseY - 42;
        // Saçak tabanı
        g.fillStyle = '#2b2d42';
        g.fillRect(sx - 34, roofBaseY - 5, 68, 6);
        g.fillStyle = '#ffd166';
        g.fillRect(sx - 35, roofBaseY - 7, 70, 2);

        // Üçgen Alınlık
        g.fillStyle = '#e9ecef';
        g.beginPath();
        g.moveTo(sx - 34, roofBaseY - 7);
        g.lineTo(sx, roofBaseY - 32);
        g.lineTo(sx + 34, roofBaseY - 7);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 2.5;
        g.stroke();

        // Alınlık İçi Oyma & Altın Lonca Arması (Guild Shield)
        g.fillStyle = '#d4a017';
        g.beginPath();
        g.arc(sx, roofBaseY - 17, 7, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#7209b7';
        g.beginPath();
        g.arc(sx, roofBaseY - 17, 4.5, 0, Math.PI * 2);
        g.fill();

        // Çatı Tepesi Altın Kartal / Tepe Süsü (Acroterion)
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.moveTo(sx, roofBaseY - 38);
        g.lineTo(sx - 5, roofBaseY - 32);
        g.lineTo(sx + 5, roofBaseY - 32);
        g.closePath();
        g.fill();

        // 6. Yan Sütunlarda Sallanan Mor & Altın Lonca Sancakları
        const bannerWave = Math.sin(globalTime * 2.5) * 2;
        // Sol Sancak
        g.fillStyle = '#7209b7';
        g.beginPath();
        g.moveTo(sx - 29, wallBaseY - 36);
        g.lineTo(sx - 20, wallBaseY - 36);
        g.lineTo(sx - 20 + bannerWave, wallBaseY - 10);
        g.lineTo(sx - 24.5 + bannerWave, wallBaseY - 14);
        g.lineTo(sx - 29 + bannerWave, wallBaseY - 10);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1;
        g.stroke();

        // Sağ Sancak
        g.fillStyle = '#7209b7';
        g.beginPath();
        g.moveTo(sx + 20, wallBaseY - 36);
        g.lineTo(sx + 29, wallBaseY - 36);
        g.lineTo(sx + 29 + bannerWave, wallBaseY - 10);
        g.lineTo(sx + 24.5 + bannerWave, wallBaseY - 14);
        g.lineTo(sx + 20 + bannerWave, wallBaseY - 10);
        g.closePath();
        g.fill();
        g.stroke();

        drawFloatingLabel(g, sx, roofBaseY - 40, '🏛️ LONCA KARARGÂHI', null, '#ffd166');
    } else if (prop.type === 'brazier') {
        const flameCycle = Math.sin(globalTime * 6 + prop.x);
        // Zemin gölgesi
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.beginPath();
        g.ellipse(sx, sy, 10, 5, 0, 0, Math.PI * 2);
        g.fill();

        // Taş Sütun Gövdesi
        g.fillStyle = '#343a40';
        g.fillRect(sx - 4, sy - 18, 8, 18);
        g.strokeStyle = '#495057';
        g.lineWidth = 1;
        g.strokeRect(sx - 4, sy - 18, 8, 18);

        // Demir Ateş Çanağı
        g.fillStyle = '#8c6239';
        g.beginPath();
        g.arc(sx, sy - 18, 8, 0, Math.PI);
        g.fill();

        // Büyülü Mor / Mavi Ateş Alevi
        const flameGrad = g.createRadialGradient(sx, sy - 24, 1, sx, sy - 24, 10);
        flameGrad.addColorStop(0, '#ffffff');
        flameGrad.addColorStop(0.3, '#00f5d4');
        flameGrad.addColorStop(0.7, '#7209b7');
        flameGrad.addColorStop(1, 'rgba(114, 9, 183, 0)');
        g.fillStyle = flameGrad;
        g.beginPath();
        g.ellipse(sx, sy - 24 + flameCycle * 1.5, 6 + flameCycle * 0.8, 9, 0, 0, Math.PI * 2);
        g.fill();
    } else if (prop.type === 'cascade_fountain') {
        const flowTime = globalTime * 4;
        const splashWave = Math.sin(globalTime * 6);

        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.35)';
        g.beginPath();
        g.ellipse(sx, sy + 6, 48, 24, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Alt Katman: Sekizgen Geniş Mermer Havuz Tabanı
        g.fillStyle = '#b0b7c3';
        g.beginPath();
        g.ellipse(sx, sy, 44, 22, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#e9ecef';
        g.beginPath();
        g.ellipse(sx, sy - 2, 42, 20, 0, 0, Math.PI * 2);
        g.fill();

        // Havuz Suyu (Turkuaz / Kristal Mavi)
        g.fillStyle = '#0077b6';
        g.beginPath();
        g.ellipse(sx, sy - 4, 38, 17, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#0096c7';
        g.beginPath();
        g.ellipse(sx, sy - 5, 34, 15, 0, 0, Math.PI * 2);
        g.fill();

        // 3. Orta Katman: Yükseltilmiş Mermer Kaide ve Havuz
        g.fillStyle = '#ced4da';
        g.fillRect(sx - 14, sy - 20, 28, 16);
        g.fillStyle = '#dee2e6';
        g.beginPath();
        g.ellipse(sx, sy - 20, 24, 12, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#48cae4';
        g.beginPath();
        g.ellipse(sx, sy - 22, 20, 9, 0, 0, Math.PI * 2);
        g.fill();

        // Orta Katmandan Alt Havuzuna Şelale Akışı (4 Köşeden Dökülen Su Perdeleri)
        g.fillStyle = 'rgba(173, 232, 244, 0.82)';
        [-16, -6, 6, 16].forEach((cx, idx) => {
            const flowOffset = Math.sin(flowTime + idx * 1.5) * 2;
            g.beginPath();
            g.moveTo(sx + cx - 2, sy - 20);
            g.lineTo(sx + cx * 1.4 + flowOffset, sy - 6);
            g.lineTo(sx + cx * 1.4 + 3 + flowOffset, sy - 6);
            g.lineTo(sx + cx + 1, sy - 20);
            g.closePath();
            g.fill();
        });

        // 4. Üst Katman: Zirve Mermer Çanak ve Fışkıran Su Sütunu
        g.fillStyle = '#adb5bd';
        g.fillRect(sx - 7, sy - 36, 14, 16);
        g.fillStyle = '#f8f9fa';
        g.beginPath();
        g.ellipse(sx, sy - 36, 13, 6, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#90e0ef';
        g.beginPath();
        g.ellipse(sx, sy - 37, 10, 4.5, 0, 0, Math.PI * 2);
        g.fill();

        // Zirveden Orta Çanağa Dökülen Şelale
        g.fillStyle = 'rgba(202, 240, 248, 0.9)';
        [-8, 0, 8].forEach(ox => {
            g.fillRect(sx + ox - 1, sy - 36, 2.5, 14);
        });

        // 5. Zirvede Fışkıran Su Jetleri & Damlacıklar
        g.strokeStyle = '#caf0f8';
        g.lineWidth = 2.2;
        g.beginPath();
        g.moveTo(sx, sy - 38);
        g.quadraticCurveTo(sx - 10, sy - 54 - splashWave * 2, sx - 14, sy - 36);
        g.moveTo(sx, sy - 38);
        g.quadraticCurveTo(sx + 10, sy - 54 - splashWave * 2, sx + 14, sy - 36);
        g.moveTo(sx, sy - 38);
        g.quadraticCurveTo(sx, sy - 58 - splashWave * 3, sx + splashWave, sy - 38);
        g.stroke();

        // Su Köpükleri ve Sıçrayan Damlalar
        g.fillStyle = '#ffffff';
        for (let i = 0; i < 5; i++) {
            const dropAng = (globalTime * 5 + i * 1.3) % (Math.PI * 2);
            const dropR = 12 + Math.sin(globalTime * 4 + i) * 8;
            g.beginPath();
            g.arc(sx + Math.cos(dropAng) * dropR, sy - 30 + Math.sin(dropAng) * 6, 1.8, 0, Math.PI * 2);
            g.fill();
        }

        // 6. Zirve Süsü: Altın Kılıçbalığı Heykeli
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.moveTo(sx - 3, sy - 38);
        g.quadraticCurveTo(sx + 6, sy - 48, sx, sy - 55);
        g.lineTo(sx - 1, sy - 47);
        g.closePath();
        g.fill();
        g.fillStyle = '#ffb703';
        g.beginPath();
        g.arc(sx + 2, sy - 46, 2.2, 0, Math.PI * 2);
        g.fill();

        drawFloatingLabel(g, sx, sy - 60, '⛲ DÖRTYOL ŞELALESİ', null, '#00f5d4');
    } else if (prop.type === 'town_hall') {
        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.beginPath();
        g.ellipse(sx, sy + 6, 56, 26, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Taş Zemin Platformu (Podium)
        g.fillStyle = '#adb5bd';
        g.beginPath();
        g.moveTo(sx - 48, sy);
        g.lineTo(sx, sy - 24);
        g.lineTo(sx + 48, sy);
        g.lineTo(sx, sy + 24);
        g.closePath();
        g.fill();
        g.strokeStyle = '#6c757d';
        g.lineWidth = 1.5;
        g.stroke();

        // Giriş Mermer Basamakları
        g.fillStyle = '#ced4da';
        g.fillRect(sx - 16, sy + 10, 32, 6);

        // 3. Alt Kat Ana Duvar (Taş & Sıva)
        const baseH = 46;
        const bY = sy - 12;
        g.fillStyle = '#f8f9fa';
        g.beginPath();
        g.moveTo(sx - 40, bY);
        g.lineTo(sx + 40, bY);
        g.lineTo(sx + 40, bY - baseH);
        g.lineTo(sx - 40, bY - baseH);
        g.closePath();
        g.fill();
        g.strokeStyle = '#495057';
        g.lineWidth = 1.2;
        g.stroke();

        // Alt Kat Taş Köşe Söveleri
        g.fillStyle = '#6c757d';
        [-38, 32].forEach(kx => {
            for (let ky = bY - baseH + 4; ky < bY; ky += 9) {
                g.fillRect(sx + kx, ky, 6, 7);
            }
        });

        // Büyük Çift Kanatlı Ahşap Konak Kapısı
        g.fillStyle = '#582f0e';
        g.beginPath();
        g.arc(sx, bY - 26, 12, Math.PI, 0);
        g.lineTo(sx + 12, bY);
        g.lineTo(sx - 12, bY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#7f4f24';
        g.lineWidth = 2;
        g.stroke();
        // Kapı Kuşakları ve Altın Tokmak
        g.strokeStyle = '#2b2d42';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(sx, bY - 26); g.lineTo(sx, bY);
        g.moveTo(sx - 10, bY - 14); g.lineTo(sx + 10, bY - 14);
        g.stroke();
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx - 4, bY - 10, 1.8, 0, Math.PI * 2);
        g.arc(sx + 4, bY - 10, 1.8, 0, Math.PI * 2);
        g.fill();

        // Alt Kat Pencereleri (Kemerli, Işıklı)
        [-26, 20].forEach(px => {
            g.fillStyle = '#ffd166';
            g.fillRect(sx + px, bY - 32, 9, 14);
            g.strokeStyle = '#343a40';
            g.lineWidth = 1;
            g.strokeRect(sx + px, bY - 32, 9, 14);
        });

        // 4. İkinci Kat: Ahşap Cumba (Çıkma Balkon)
        const cY = bY - baseH;
        g.fillStyle = '#7f4f24';
        g.fillRect(sx - 20, cY - 22, 40, 22);
        g.strokeStyle = '#432818';
        g.lineWidth = 1.5;
        g.strokeRect(sx - 20, cY - 22, 40, 22);

        // Cumba Altı Destek Ahşap Payandalar (Corbels)
        g.fillStyle = '#936639';
        [-16, -6, 6, 16].forEach(px => {
            g.beginPath();
            g.moveTo(sx + px - 2, cY);
            g.lineTo(sx + px, cY + 8);
            g.lineTo(sx + px + 2, cY);
            g.closePath();
            g.fill();
        });

        // Cumba Camları (Sıcak Sarı İç Işık)
        [-14, -4, 6].forEach(wx => {
            g.fillStyle = 'rgba(255, 209, 102, 0.9)';
            g.fillRect(sx + wx, cY - 18, 8, 12);
            g.strokeStyle = '#432818';
            g.lineWidth = 1;
            g.strokeRect(sx + wx, cY - 18, 8, 12);
        });

        // 5. Kiremit Çatı (Geniş Saçaklı Alaturka Kiremit)
        const roofY = cY - 22;
        g.fillStyle = '#c84b31';
        g.beginPath();
        g.moveTo(sx - 46, roofY);
        g.lineTo(sx, roofY - 26);
        g.lineTo(sx + 46, roofY);
        g.lineTo(sx + 38, roofY + 4);
        g.lineTo(sx - 38, roofY + 4);
        g.closePath();
        g.fill();
        g.strokeStyle = '#9d0208';
        g.lineWidth = 2;
        g.stroke();

        // Kiremit Sıra Çizgileri
        g.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        g.lineWidth = 1;
        for (let rx = -34; rx <= 34; rx += 10) {
            g.beginPath();
            g.moveTo(sx + rx, roofY);
            g.lineTo(sx + rx * 0.2, roofY - 22);
            g.stroke();
        }

        // 6. Çatı Tepesi Saat Kulesi / Fener Köşkü & Bayrak
        g.fillStyle = '#f8f9fa';
        g.fillRect(sx - 7, roofY - 36, 14, 12);
        g.strokeStyle = '#7f4f24';
        g.lineWidth = 1.2;
        g.strokeRect(sx - 7, roofY - 36, 14, 12);

        // Minik Saat Kadranı
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx, roofY - 30, 4, 0, Math.PI * 2);
        g.fill();

        // Piramit Külah & Altın Hilal
        g.fillStyle = '#c84b31';
        g.beginPath();
        g.moveTo(sx - 9, roofY - 36);
        g.lineTo(sx, roofY - 48);
        g.lineTo(sx + 9, roofY - 36);
        g.closePath();
        g.fill();
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx, roofY - 50, 2.5, 0, Math.PI * 2);
        g.fill();

        // Kapı Yanı İlan Panosu (Notice Board)
        g.fillStyle = '#936639';
        g.fillRect(sx + 24, bY - 24, 12, 14);
        g.fillStyle = '#fefae0';
        g.fillRect(sx + 25, bY - 22, 10, 10);
        g.fillStyle = '#d62828';
        g.fillRect(sx + 29, bY - 21, 2, 2);

        drawFloatingLabel(g, sx, roofY - 54, '🏛️ HÜKÜMET KONAĞI', null, '#ffd166');
    } else if (prop.type === 'alchemy_tower') {
        const pulse = Math.sin(globalTime * 3);

        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.38)';
        g.beginPath();
        g.ellipse(sx, sy + 4, 38, 20, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Kule Taş Tabanı
        g.fillStyle = '#495057';
        g.beginPath();
        g.ellipse(sx, sy, 32, 16, 0, 0, Math.PI * 2);
        g.fill();

        // 3. Yuvarlak Kule Silindirik Gövdesi
        const tH = 64;
        const tY = sy - 8;
        const towerGrad = g.createLinearGradient(sx - 24, tY, sx + 24, tY);
        towerGrad.addColorStop(0, '#212529');
        towerGrad.addColorStop(0.5, '#495057');
        towerGrad.addColorStop(1, '#343a40');
        g.fillStyle = towerGrad;
        g.beginPath();
        g.moveTo(sx - 22, tY);
        g.lineTo(sx + 22, tY);
        g.lineTo(sx + 18, tY - tH);
        g.lineTo(sx - 18, tY - tH);
        g.closePath();
        g.fill();

        // Taş Duvar Derz Çizgileri
        g.strokeStyle = '#6c757d';
        g.lineWidth = 1;
        for (let ly = tY - 12; ly > tY - tH; ly -= 12) {
            g.beginPath();
            g.moveTo(sx - 20, ly);
            g.lineTo(sx + 20, ly);
            g.stroke();
        }

        // Büyü Kulesi Ahşap Giriş Kapısı
        g.fillStyle = '#3a0ca3';
        g.beginPath();
        g.arc(sx, tY - 14, 7, Math.PI, 0);
        g.lineTo(sx + 7, tY);
        g.lineTo(sx - 7, tY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.2;
        g.stroke();

        // Büyülü Vitray Pencere (Mor / Camgöbeği Işık Atımı)
        const winGrad = g.createRadialGradient(sx, tY - 38, 1, sx, tY - 38, 12);
        winGrad.addColorStop(0, `rgba(247, 37, 133, ${0.85 + pulse * 0.15})`);
        winGrad.addColorStop(0.6, `rgba(114, 9, 183, ${0.65 + pulse * 0.15})`);
        winGrad.addColorStop(1, '#03045e');
        g.fillStyle = winGrad;
        g.beginPath();
        g.arc(sx, tY - 38, 9, Math.PI, 0);
        g.lineTo(sx + 9, tY - 26);
        g.lineTo(sx - 9, tY - 26);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.5;
        g.stroke();

        // 4. Koni Biçiminde Yüksek Mor Büyücü Çatısı
        const rY = tY - tH;
        g.fillStyle = '#3a0ca3';
        g.beginPath();
        g.moveTo(sx - 24, rY);
        g.lineTo(sx, rY - 44);
        g.lineTo(sx + 24, rY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#7209b7';
        g.lineWidth = 2;
        g.stroke();

        // Çatı Saçak Şeritleri (Koyu Altın)
        g.fillStyle = '#ffd166';
        g.fillRect(sx - 25, rY - 3, 50, 4);

        // Çatı Tepesi Büyülü Kristal Küre (Aura Yayan Işık)
        g.fillStyle = '#00f5d4';
        g.beginPath();
        g.arc(sx, rY - 47, 4.5, 0, Math.PI * 2);
        g.fill();

        // Havada Süzülen Simya Parıltıları
        for (let i = 0; i < 3; i++) {
            const sparkAng = globalTime * 2.5 + (i * Math.PI * 2 / 3);
            const sparkDist = 18 + Math.sin(globalTime * 3 + i) * 6;
            const spX = sx + Math.cos(sparkAng) * sparkDist;
            const spY = (tY - 38) + Math.sin(sparkAng) * 10;
            g.fillStyle = i % 2 === 0 ? '#f72585' : '#00f5d4';
            g.beginPath();
            g.arc(spX, spY, 2, 0, Math.PI * 2);
            g.fill();
        }

        // Kule Önü Simya Tezgâhı & İmbikler
        g.fillStyle = '#7f4f24';
        g.fillRect(sx + 14, tY - 10, 14, 8);
        g.fillStyle = '#00f5d4';
        g.beginPath();
        g.arc(sx + 18, tY - 12, 3, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#f72585';
        g.beginPath();
        g.arc(sx + 24, tY - 12, 2.5, 0, Math.PI * 2);
        g.fill();

        drawFloatingLabel(g, sx, rY - 52, '🔮 SİMYA & BÜYÜ KULESİ', null, '#b5179e');
    } else if (prop.type === 'bank_vault') {
        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.beginPath();
        g.ellipse(sx, sy + 5, 48, 22, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Taş Zemin Platformu
        g.fillStyle = '#343a40';
        g.beginPath();
        g.moveTo(sx - 42, sy);
        g.lineTo(sx, sy - 21);
        g.lineTo(sx + 42, sy);
        g.lineTo(sx, sy + 21);
        g.closePath();
        g.fill();

        // 3. Granit Taş Kasa Binası (Heavy Granite Vault)
        const vH = 50;
        const vY = sy - 10;
        g.fillStyle = '#495057';
        g.beginPath();
        g.moveTo(sx - 36, vY);
        g.lineTo(sx + 36, vY);
        g.lineTo(sx + 36, vY - vH);
        g.lineTo(sx - 36, vY - vH);
        g.closePath();
        g.fill();
        g.strokeStyle = '#212529';
        g.lineWidth = 2;
        g.stroke();

        // Granit Blok Hatları
        g.strokeStyle = '#343a40';
        g.lineWidth = 1;
        for (let gy = vY - 10; gy > vY - vH; gy -= 10) {
            g.beginPath();
            g.moveTo(sx - 34, gy);
            g.lineTo(sx + 34, gy);
            g.stroke();
        }

        // Ağır Demir Kasa Kapısı (Arched Iron Vault Door)
        g.fillStyle = '#1b263b';
        g.beginPath();
        g.arc(sx, vY - 26, 14, Math.PI, 0);
        g.lineTo(sx + 14, vY);
        g.lineTo(sx - 14, vY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 2.5;
        g.stroke();

        // Kapı Üzeri Perçinler ve Kasa Çarkı
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx, vY - 18, 5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#212529';
        g.beginPath();
        g.arc(sx, vY - 18, 2.5, 0, Math.PI * 2);
        g.fill();

        // 4. Çatı Korkulukları ve Altın Tabela / Arma
        const rY = vY - vH;
        g.fillStyle = '#212529';
        g.fillRect(sx - 38, rY - 6, 76, 8);
        g.fillStyle = '#ffd166';
        g.fillRect(sx - 38, rY - 8, 76, 2);

        // Çatı Mazgalları (Crenellations)
        for (let cx = -34; cx <= 30; cx += 16) {
            g.fillStyle = '#495057';
            g.fillRect(sx + cx, rY - 14, 10, 8);
        }

        // Kapı Üzeri Altın Banka Arması
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx, vY - 38, 7, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#212529';
        g.font = 'bold 9px sans-serif';
        g.textAlign = 'center';
        g.fillText('$', sx, vY - 35);

        // Kasa Yanında Yığılı Demir Kuşaklı Hazine Sandığı
        g.fillStyle = '#8c6239';
        g.fillRect(sx + 20, vY - 10, 14, 10);
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.2;
        g.strokeRect(sx + 20, vY - 10, 14, 10);
        // Altın Paralar
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx + 22, vY + 2, 2.5, 0, Math.PI * 2);
        g.arc(sx + 27, vY + 2, 2.5, 0, Math.PI * 2);
        g.fill();

        drawFloatingLabel(g, sx, rY - 18, '🏦 MERKEZ BANKASI', null, '#4cc9f0');
    } else if (prop.type === 'gambler_pavilion') {
        const sway = Math.sin(globalTime * 2);

        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.35)';
        g.beginPath();
        g.ellipse(sx, sy + 5, 46, 22, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Halı / Mozaik Podyum Tabanı
        g.fillStyle = '#780001';
        g.beginPath();
        g.ellipse(sx, sy, 40, 18, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 2;
        g.stroke();

        // 3. Altın İşlemeli 4 Pirinç Sütun
        const postH = 42;
        const pY = sy - 8;
        [-28, -10, 10, 28].forEach(px => {
            g.fillStyle = '#ffd166';
            g.fillRect(sx + px - 2, pY - postH, 4, postH);
            g.fillStyle = '#c1121f';
            g.fillRect(sx + px - 3, pY - postH - 2, 6, 3);
        });

        // 4. Yanlarda Dökülen Kırmızı & Altın İpek Perdeler (Drapes)
        g.fillStyle = '#9b2226';
        // Sol Perde
        g.beginPath();
        g.moveTo(sx - 30, pY - postH);
        g.quadraticCurveTo(sx - 24 + sway, pY - 18, sx - 28, pY);
        g.lineTo(sx - 22, pY);
        g.quadraticCurveTo(sx - 18 + sway, pY - 18, sx - 22, pY - postH);
        g.closePath();
        g.fill();
        // Sağ Perde
        g.beginPath();
        g.moveTo(sx + 30, pY - postH);
        g.quadraticCurveTo(sx + 24 - sway, pY - 18, sx + 28, pY);
        g.lineTo(sx + 22, pY);
        g.quadraticCurveTo(sx + 18 - sway, pY - 18, sx + 22, pY - postH);
        g.closePath();
        g.fill();

        // 5. İpek Çadır Kubbesi (Kırmızı & Altın Dilimli Kubbe)
        const domeY = pY - postH;
        g.fillStyle = '#ae2012';
        g.beginPath();
        g.moveTo(sx - 34, domeY);
        g.quadraticCurveTo(sx, domeY - 32, sx + 34, domeY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 2.5;
        g.stroke();

        // Kubbe Altın Şeritleri
        [-20, -7, 7, 20].forEach(kx => {
            g.strokeStyle = '#ffd166';
            g.lineWidth = 1.8;
            g.beginPath();
            g.moveTo(sx + kx, domeY);
            g.quadraticCurveTo(sx + kx * 0.4, domeY - 26, sx, domeY - 28);
            g.stroke();
        });

        // Saçak Uçlarındaki Altın Püsküller
        for (let tx = -30; tx <= 30; tx += 10) {
            g.fillStyle = '#ffd166';
            g.beginPath();
            g.arc(sx + tx, domeY + 2, 2, 0, Math.PI * 2);
            g.fill();
        }

        // Çadır Tepesi Altın Zar Heykeli (Lucky Dice Finial)
        g.fillStyle = '#ffd166';
        g.fillRect(sx - 6, domeY - 38, 12, 10);
        g.strokeStyle = '#b7094c';
        g.lineWidth = 1.2;
        g.strokeRect(sx - 6, domeY - 38, 12, 10);
        // Zar Noktaları
        g.fillStyle = '#b7094c';
        g.beginPath();
        g.arc(sx - 2.5, domeY - 35, 1.2, 0, Math.PI * 2);
        g.arc(sx + 2.5, domeY - 31, 1.2, 0, Math.PI * 2);
        g.fill();

        // Çadır İçi Zar Masası & Saçılmış Altınlar
        g.fillStyle = '#005f73';
        g.beginPath();
        g.ellipse(sx, pY - 8, 14, 6, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(sx - 3, pY - 8, 2, 0, Math.PI * 2);
        g.arc(sx + 3, pY - 8, 2, 0, Math.PI * 2);
        g.fill();

        drawFloatingLabel(g, sx, domeY - 42, '🎲 ŞANS KÖŞKÜ', null, '#ff006e');
    } else if (prop.type === 'carpenter_workshop') {
        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.35)';
        g.beginPath();
        g.ellipse(sx, sy + 4, 46, 20, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Ahşap Zemin Platformu
        g.fillStyle = '#60412b';
        g.beginPath();
        g.moveTo(sx - 38, sy);
        g.lineTo(sx, sy - 19);
        g.lineTo(sx + 38, sy);
        g.lineTo(sx, sy + 19);
        g.closePath();
        g.fill();

        // 3. Masif Çam Ağacı Sütunlar ve Ahşap İskelet
        const wH = 38;
        const wY = sy - 8;
        [-28, -8, 8, 28].forEach(px => {
            g.fillStyle = '#7f4f24';
            g.fillRect(sx + px - 3, wY - wH, 6, wH);
            g.fillStyle = '#936639';
            g.fillRect(sx + px - 2, wY - wH, 3, wH);
        });

        // 4. Ahşap Şingıl / Kiremit Çatı
        const rY = wY - wH;
        g.fillStyle = '#582f0e';
        g.beginPath();
        g.moveTo(sx - 36, rY);
        g.lineTo(sx, rY - 20);
        g.lineTo(sx + 36, rY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#936639';
        g.lineWidth = 2;
        g.stroke();

        // Çatı Ahşap Tahta Çizgileri
        for (let tx = -28; tx <= 28; tx += 8) {
            g.strokeStyle = '#3d2314';
            g.lineWidth = 1.2;
            g.beginPath();
            g.moveTo(sx + tx, rY);
            g.lineTo(sx + tx * 0.3, rY - 18);
            g.stroke();
        }

        // Marangoz Tezgâhı & Testere
        g.fillStyle = '#936639';
        g.fillRect(sx - 14, wY - 12, 28, 10);
        g.strokeStyle = '#582f0e';
        g.strokeRect(sx - 14, wY - 12, 28, 10);

        // Tezgâh Üzerinde Rende ve Ahşap Talaşlar
        g.fillStyle = '#c6ac8f';
        g.fillRect(sx - 8, wY - 15, 7, 4);
        g.fillStyle = '#e0a96d';
        g.beginPath();
        g.arc(sx + 4, wY - 13, 2, 0, Math.PI * 2);
        g.arc(sx + 8, wY - 13, 2.5, 0, Math.PI * 2);
        g.fill();

        // Yan Tarafta Yığılı Kesilmiş Çam Kütükleri
        [-24, -18, -12].forEach((kx, idx) => {
            g.fillStyle = '#7f4f24';
            g.fillRect(sx + kx, wY - 8 + (idx * 2), 6, 12);
            g.fillStyle = '#c6ac8f';
            g.beginPath();
            g.arc(sx + kx + 3, wY - 8 + (idx * 2), 3, 0, Math.PI * 2);
            g.fill();
        });

        drawFloatingLabel(g, sx, rY - 24, '🪚 MARANGOZ ATÖLYESİ', null, '#e0a96d');
    } else if (prop.type === 'market_bazaar') {
        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.45)';
        g.beginPath();
        g.ellipse(sx, sy + 6, 52, 24, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Taş & Mermer Podyum Zemin
        g.fillStyle = '#6c757d';
        g.beginPath();
        g.moveTo(sx - 44, sy);
        g.lineTo(sx, sy - 22);
        g.lineTo(sx + 44, sy);
        g.lineTo(sx, sy + 22);
        g.closePath();
        g.fill();
        g.strokeStyle = '#adb5bd';
        g.lineWidth = 1.5;
        g.stroke();

        // 3. Ahşap Pazar Tezgahı & Gövde
        const bH = 38;
        const bY = sy - 8;
        g.fillStyle = '#7f4f24';
        g.beginPath();
        g.moveTo(sx - 38, bY);
        g.lineTo(sx + 38, bY);
        g.lineTo(sx + 38, bY - bH);
        g.lineTo(sx - 38, bY - bH);
        g.closePath();
        g.fill();
        g.strokeStyle = '#582f0e';
        g.lineWidth = 2;
        g.stroke();

        // 4. Ahşap Destek Sütunları
        g.fillStyle = '#936639';
        [-34, -12, 12, 34].forEach(px => {
            g.fillRect(sx + px - 3, bY - bH - 24, 6, 26);
            g.strokeStyle = '#582f0e';
            g.strokeRect(sx + px - 3, bY - bH - 24, 6, 26);
        });

        // 5. Çizgili Pazar Tenteli Çatı (Kırmızı-Altın Çizgili Tente)
        const roofY = bY - bH - 22;
        const stripes = ['#d90429', '#ffd166', '#d90429', '#ffd166', '#d90429', '#ffd166', '#d90429', '#ffd166'];
        const segW = 10;
        for (let i = 0; i < stripes.length; i++) {
            const x1 = sx - 40 + (i * segW);
            const x2 = x1 + segW;
            g.fillStyle = stripes[i];
            g.beginPath();
            g.moveTo(x1, roofY + 12);
            g.lineTo(x1 + 3, roofY - 14);
            g.lineTo(x2 + 3, roofY - 14);
            g.lineTo(x2, roofY + 12);
            g.closePath();
            g.fill();
            g.strokeStyle = 'rgba(0, 0, 0, 0.25)';
            g.lineWidth = 1;
            g.stroke();
        }

        // Tente Saçakları
        for (let i = 0; i < stripes.length; i++) {
            const x1 = sx - 40 + (i * segW);
            g.fillStyle = stripes[i];
            g.beginPath();
            g.arc(x1 + 5, roofY + 13, 5, 0, Math.PI);
            g.fill();
        }

        // 6. Tezgah Üzerindeki Mallar (Balık Kasası & Hazine Sandığı)
        g.fillStyle = '#a68a64';
        g.fillRect(sx - 28, bY - 20, 16, 12);
        g.strokeRect(sx - 28, bY - 20, 16, 12);
        g.fillStyle = '#3a86ff';
        g.beginPath();
        g.arc(sx - 20, bY - 14, 4, 0, Math.PI * 2);
        g.fill();

        g.fillStyle = '#582f0e';
        g.fillRect(sx + 12, bY - 22, 18, 14);
        g.strokeRect(sx + 12, bY - 22, 18, 14);
        g.fillStyle = '#ffd166';
        g.fillRect(sx + 14, bY - 20, 14, 5);

        // 7. Asılı Adalet & Ticaret Terazisi Simgesi
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(sx, roofY);
        g.lineTo(sx, roofY + 10);
        g.moveTo(sx - 7, roofY + 10);
        g.lineTo(sx + 7, roofY + 10);
        g.moveTo(sx - 7, roofY + 10);
        g.lineTo(sx - 7, roofY + 16);
        g.moveTo(sx + 7, roofY + 10);
        g.lineTo(sx + 7, roofY + 16);
        g.stroke();
        g.fillStyle = '#e9c46a';
        g.beginPath();
        g.arc(sx - 7, roofY + 17, 3, 0, Math.PI);
        g.arc(sx + 7, roofY + 17, 3, 0, Math.PI);
        g.fill();

        // 8. Fenerler
        g.fillStyle = '#ffbe0b';
        g.beginPath();
        g.arc(sx - 34, roofY + 14, 3.5, 0, Math.PI * 2);
        g.arc(sx + 34, roofY + 14, 3.5, 0, Math.PI * 2);
        g.fill();

        drawFloatingLabel(g, sx, roofY - 24, '⚖️ DÖRTYOL PAZARI', null, '#ffd166');
    } else if (prop.type === 'bakery_tavern') {
        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.beginPath();
        g.ellipse(sx, sy + 5, 46, 22, 0, 0, Math.PI * 2);
        g.fill();

        // 2. Taş & Tuğla Zemin
        g.fillStyle = '#b08968';
        g.beginPath();
        g.moveTo(sx - 40, sy);
        g.lineTo(sx, sy - 20);
        g.lineTo(sx + 40, sy);
        g.lineTo(sx, sy + 20);
        g.closePath();
        g.fill();

        // 3. Sıcak Kırmızı Tuğla Duvarlar
        const bH = 44;
        const bY = sy - 10;
        g.fillStyle = '#9c6644';
        g.beginPath();
        g.moveTo(sx - 34, bY);
        g.lineTo(sx + 34, bY);
        g.lineTo(sx + 34, bY - bH);
        g.lineTo(sx - 34, bY - bH);
        g.closePath();
        g.fill();
        g.strokeStyle = '#7f4f24';
        g.lineWidth = 1.5;
        g.stroke();

        // Tuğla Derzleri
        g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        g.lineWidth = 1;
        for (let by = bY - 8; by > bY - bH; by -= 8) {
            g.beginPath();
            g.moveTo(sx - 32, by);
            g.lineTo(sx + 32, by);
            g.stroke();
        }

        // Kırmızı / Beyaz Şeritli Tente (Awning)
        const tY = bY - 24;
        const stripW = 8;
        for (let i = 0; i < 8; i++) {
            g.fillStyle = i % 2 === 0 ? '#d90429' : '#f8f9fa';
            g.beginPath();
            g.moveTo(sx - 32 + i * stripW, tY);
            g.lineTo(sx - 32 + (i + 1) * stripW, tY);
            g.lineTo(sx - 34 + (i + 1) * stripW, tY + 12);
            g.lineTo(sx - 34 + i * stripW, tY + 12);
            g.closePath();
            g.fill();
        }

        // Fırın Camlı Vitrini & Taze Ekmek / Balık Çorbası
        g.fillStyle = '#ffe49e';
        g.fillRect(sx - 18, bY - 20, 36, 14);
        g.strokeStyle = '#582f0e';
        g.lineWidth = 1.2;
        g.strokeRect(sx - 18, bY - 20, 36, 14);

        // Vitrinde Altın Ekmekler & Balık Turtaları
        g.fillStyle = '#ddb892';
        g.beginPath();
        g.ellipse(sx - 8, bY - 13, 5, 3, 0, 0, Math.PI * 2);
        g.ellipse(sx + 8, bY - 13, 5, 3, 0, 0, Math.PI * 2);
        g.fill();

        // 4. Kiremit Çatı & Tüten Tuğla Baca
        const rY = bY - bH;
        g.fillStyle = '#b7094c';
        g.beginPath();
        g.moveTo(sx - 38, rY);
        g.lineTo(sx, rY - 24);
        g.lineTo(sx + 38, rY);
        g.closePath();
        g.fill();
        g.strokeStyle = '#800f2f';
        g.lineWidth = 2;
        g.stroke();

        // Tuğla Baca
        g.fillStyle = '#7f4f24';
        g.fillRect(sx + 14, rY - 26, 10, 16);
        // Baca Dumanı
        const dumanProg = (globalTime * 1.5) % 2;
        g.fillStyle = `rgba(240, 240, 240, ${Math.max(0, 0.6 - dumanProg * 0.25)})`;
        g.beginPath();
        g.arc(sx + 19 + Math.sin(dumanProg * 3) * 4, rY - 28 - dumanProg * 14, 4 + dumanProg * 3, 0, Math.PI * 2);
        g.fill();

        // Kapı Önü Şarap / Elma Suyu Fıçısı
        g.fillStyle = '#6f4e37';
        g.beginPath();
        g.ellipse(sx + 24, bY - 4, 7, 10, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#ffd166';
        g.lineWidth = 1.2;
        g.stroke();

        drawFloatingLabel(g, sx, rY - 28, '🍳 GURME MUTFAK', null, '#ffd166');
    } else if (prop.type === 'fisher_shack') {
        // 1. Zemin Gölgesi
        g.fillStyle = 'rgba(0, 0, 0, 0.35)';
        g.beginPath();
        g.ellipse(sx, sy + 4, 42, 18, 0, 0, Math.PI * 2);
        g.fill();

        // 2. İskele Tahtaları Tabanı
        g.fillStyle = '#7f5539';
        g.beginPath();
        g.moveTo(sx - 34, sy);
        g.lineTo(sx, sy - 17);
        g.lineTo(sx + 34, sy);
        g.lineTo(sx, sy + 17);
        g.closePath();
        g.fill();

        // 3. Yıpranmış Sedir Ahşap Kulübe Duvarı
        const sH = 36;
        const sY = sy - 8;
        g.fillStyle = '#9c6644';
        g.beginPath();
        g.moveTo(sx - 28, sY);
        g.lineTo(sx + 28, sY);
        g.lineTo(sx + 28, sY - sH);
        g.lineTo(sx - 28, sY - sH);
        g.closePath();
        g.fill();
        g.strokeStyle = '#432818';
        g.lineWidth = 1.5;
        g.stroke();

        // Yatay Ahşap Kaplama Tahtaları
        g.strokeStyle = '#603813';
        g.lineWidth = 1;
        for (let ty = sY - 6; ty > sY - sH; ty -= 6) {
            g.beginPath();
            g.moveTo(sx - 26, ty);
            g.lineTo(sx + 26, ty);
            g.stroke();
        }

        // Mavi Yelken Bezi Tente
        g.fillStyle = '#0077b6';
        g.beginPath();
        g.moveTo(sx - 32, sY - 20);
        g.lineTo(sx + 32, sY - 20);
        g.lineTo(sx + 26, sY - 6);
        g.lineTo(sx - 26, sY - 6);
        g.closePath();
        g.fill();
        g.strokeStyle = '#023e8a';
        g.lineWidth = 1.5;
        g.stroke();

        // Kulübe Çatısı
        const rY = sY - sH;
        g.fillStyle = '#582f0e';
        g.beginPath();
        g.moveTo(sx - 32, rY);
        g.lineTo(sx, rY - 16);
        g.lineTo(sx + 32, rY);
        g.closePath();
        g.fill();

        // Kulübe Duvarında Asılı Can Simidi (Lifebuoy)
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(sx - 14, sY - 24, 6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#e63946';
        g.beginPath();
        g.arc(sx - 14, sY - 24, 6, 0, Math.PI * 0.5);
        g.arc(sx - 14, sY - 24, 6, Math.PI, Math.PI * 1.5);
        g.fill();
        g.fillStyle = '#9c6644';
        g.beginPath();
        g.arc(sx - 14, sY - 24, 3, 0, Math.PI * 2);
        g.fill();

        // Asılı Kurutulmuş Balıklar ve Balık Ağı
        g.strokeStyle = 'rgba(240, 240, 240, 0.45)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx + 4, sY - 28); g.lineTo(sx + 24, sY - 28);
        g.stroke();
        // Kurutulan minik balıklar
        [8, 14, 20].forEach(bx => {
            g.fillStyle = '#ced4da';
            g.beginPath();
            g.ellipse(sx + bx, sY - 22, 2, 5, 0, 0, Math.PI * 2);
            g.fill();
        });

        // Balıkçı Kasası ve Yem Kovası
        g.fillStyle = '#7f4f24';
        g.fillRect(sx - 24, sY - 8, 10, 8);
        g.fillStyle = '#ffbe0b';
        g.beginPath();
        g.arc(sx - 19, sY - 5, 2.5, 0, Math.PI * 2);
        g.fill();

        drawFloatingLabel(g, sx, rY - 20, '🎣 BALIKÇI BARINAĞI', null, '#f4a261');
    } else if (prop.type === 'stone_bench') {
        g.fillStyle = 'rgba(0, 0, 0, 0.3)';
        g.beginPath();
        g.ellipse(sx, sy + 2, 16, 7, 0, 0, Math.PI * 2);
        g.fill();

        // Mermer Bank Ayakları
        g.fillStyle = '#adb5bd';
        g.fillRect(sx - 10, sy - 8, 4, 8);
        g.fillRect(sx + 6, sy - 8, 4, 8);

        // Mermer Oturak Levhası
        g.fillStyle = '#f8f9fa';
        g.beginPath();
        g.moveTo(sx - 14, sy - 8);
        g.lineTo(sx + 14, sy - 8);
        g.lineTo(sx + 12, sy - 4);
        g.lineTo(sx - 16, sy - 4);
        g.closePath();
        g.fill();
        g.strokeStyle = '#ced4da';
        g.lineWidth = 1;
        g.stroke();

        // Mermer Sırtlık
        g.fillStyle = '#e9ecef';
        g.fillRect(sx - 14, sy - 16, 28, 6);
    } else if (prop.type === 'planter') {
        g.fillStyle = 'rgba(0, 0, 0, 0.3)';
        g.beginPath();
        g.ellipse(sx, sy + 2, 12, 6, 0, 0, Math.PI * 2);
        g.fill();

        // Saksı Taş Gövdesi
        g.fillStyle = '#b08968';
        g.beginPath();
        g.moveTo(sx - 9, sy - 14);
        g.lineTo(sx + 9, sy - 14);
        g.lineTo(sx + 7, sy);
        g.lineTo(sx - 7, sy);
        g.closePath();
        g.fill();
        g.strokeStyle = '#7f4f24';
        g.lineWidth = 1;
        g.stroke();

        // Saksı Toprağı ve Çiçekler
        g.fillStyle = '#38b000';
        g.beginPath();
        g.ellipse(sx, sy - 15, 10, 5, 0, 0, Math.PI * 2);
        g.fill();

        // Renkli Çiçek Tomurcukları (Kırmızı, Sarı, Mor)
        [-5, 0, 5].forEach((fx, idx) => {
            const colors = ['#ff006e', '#ffd166', '#7209b7'];
            g.fillStyle = colors[idx];
            g.beginPath();
            g.arc(sx + fx, sy - 18, 2.5, 0, Math.PI * 2);
            g.fill();
        });
    } else if (prop.type === 'kraken_reef') {
        // Kızıl Mercan Kayalığı
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.beginPath();
        g.ellipse(sx, sy + 4, 18, 9, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#6b0f1a';
        g.beginPath();
        g.moveTo(sx - 12, sy);
        g.lineTo(sx - 4, sy - 24);
        g.lineTo(sx + 8, sy - 14);
        g.lineTo(sx + 14, sy);
        g.closePath();
        g.fill();
        g.strokeStyle = '#e63946';
        g.lineWidth = 1.5;
        g.stroke();
    } else if (prop.type === 'kraken_wreck') {
        // Batık Gemi Kırık Direği
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.beginPath();
        g.ellipse(sx, sy + 4, 20, 10, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#2b1b17';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(sx - 6, sy + 2);
        g.lineTo(sx + 12, sy - 34);
        g.stroke();
        g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx + 12, sy - 34);
        g.lineTo(sx - 14, sy - 10);
        g.stroke();
    }
}

// ============================================================================
// 11. OYUN DÖNGÜSÜ (UPDATE & RENDER)
// ============================================================================
let buffUiTimer = 0;

function update(dt) {
    globalTime += dt;

    // Aktif yemek buff sürelerini güncelle
    if (player.buffs.length > 0) {
        player.buffs.forEach(b => { b.remaining -= dt; });
        player.buffs = player.buffs.filter(b => b.remaining > 0);
    }

    // Aktif konuşma baloncuğu (Chat Bubble) süresini güncelle
    if (player.chatBubble) {
        player.chatBubble.timer -= dt;
        if (player.chatBubble.timer <= 0) {
            player.chatBubble = null;
        }
    }

    // Sol alttaki Aktif Buff panelini her saniye güncelle (Süreli olanların sayacını canlı tutar)
    buffUiTimer += dt;
    if (buffUiTimer >= 1.0) {
        buffUiTimer = 0;
        renderBuffBar();
    }

    // Akdeniz Sarı Bereket Bölgesi Zamanlayıcısı (Oyuncu haritada olmasa bile arka planda 5 dakikada bir yer değiştirir)
    oceanHotspot.timer -= dt;
    if (oceanHotspot.timer <= 0) {
        relocateOceanHotspot(true);
    }

    // Kraken Seferi Zaman Kontrolü & Süre Sonu Otomatik Tahliye (Kraken Zamanı Bittiğinde)
    if (currentMapId === 'kraken') {
        if (!isKrakenEventActive()) {
            returnFromKrakenToDortyolDueToEndOfEvent();
        }
    }

    // Oyuncu Hareketi (Akdeniz'de tekne hızına göre, karada normal yürüyüş hızına göre)
    if (player.path.length > 0) {
        const next = player.path[0];
        const dx = next.x - player.x;
        const dy = next.y - player.y;
        const dist = Math.hypot(dx, dy);

        const currentMoveSpeed = (currentMapId === 'kraken')
            ? (BOATS.boat_destroyer?.speed || 6.2)
            : ((currentMapId === 'akdeniz' && BOATS[player.activeBoatId])
                ? BOATS[player.activeBoatId].speed
                : player.speed);

        if (dist < 0.08) {
            player.x = next.x;
            player.y = next.y;
            player.path.shift();
            if (player.path.length === 0 && player.pendingInteraction) {
                const targetInter = player.pendingInteraction;
                player.pendingInteraction = null;
                interactWithObject(targetInter);
            }
        } else {
            player.dirX = dx / dist;
            player.dirY = dy / dist;
            const step = Math.min(dist, currentMoveSpeed * dt);
            player.x += player.dirX * step;
            player.y += player.dirY * step;
            player.walkCycle += dt;

            // Çok Oyunculu Canlı Pozisyon Senkronizasyonu (Socket.io)
            if (socket && socket.connected) {
                const now = performance.now();
                if (now - lastMoveEmitTime > 80) {
                    lastMoveEmitTime = now;
                    socket.emit('player_move', {
                        x: Number(player.x.toFixed(2)),
                        y: Number(player.y.toFixed(2)),
                        dirX: Number((player.dirX || 1).toFixed(2)),
                        dirY: Number((player.dirY || 0).toFixed(2)),
                        isMoving: true,
                        costume: player.equipped.costume,
                        boatId: (currentMapId === 'akdeniz' || currentMapId === 'kraken') ? player.activeBoatId : null
                    });
                }
            }
        }
    }

    if (player.targetMarker) {
        player.targetMarker.timer -= dt;
        if (player.targetMarker.timer <= 0 && player.path.length === 0) {
            player.targetMarker = null;
        }
    }

    // Konum Rozeti & Kraken Dönüş Butonu Görünürlük Kontrolü
    const krakenBtn = document.getElementById('kraken-return-btn');
    if (krakenBtn) {
        krakenBtn.style.display = (currentMapId === 'kraken') ? 'inline-flex' : 'none';
    }
    const locBadge = document.getElementById('location-badge');
    const m = getActiveMap();
    const nearInter = findNearbyInteractable();
    const nearWater = findNearbyWater();

    if (nearInter) {
        locBadge.textContent = `📍 ${m.name} • [SPACE / Tıkla: ${nearInter.name}]`;
    } else if (currentMapId === 'akdeniz') {
        const inHot = isInOceanHotspot(player.x, player.y);
        const remMins = Math.floor(oceanHotspot.timer / 60);
        const remSecs = Math.floor(oceanHotspot.timer % 60).toString().padStart(2, '0');
        const bName = BOATS[player.activeBoatId]?.name || 'Tekne';
        locBadge.textContent = inHot
            ? `📍 Akdeniz 🌟 Sarı Bereket Alanındasın! (1.5x Şans • Kalan: ${remMins}:${remSecs}) [${bName}]`
            : `📍 Akdeniz (Açık Okyanus) [${bName} ile seyirde]`;
    } else if (currentMapId === 'kraken') {
        const evStatus = getKrakenEventStatus();
        const roleLabel = isPlayerGuildLeader() ? '👑 Dümendesin (Lider)' : '⚓ Güvertedesin (Üye)';
        const timeNote = evStatus.timeRemainingFormatted ? ` • Kalan: ${evStatus.timeRemainingFormatted}` : '';
        locBadge.textContent = `📍 Kraken Bölgesi (Kızıl Okyanus) • [Lonca Destroyer'i • ${roleLabel}${timeNote}]`;
    } else if (nearWater) {
        locBadge.textContent = nearWater.tile === TILE.LAKE
            ? `📍 ${m.name} - Küçük Göl (SPACE: Olta | O: Auto-Hunt)`
            : `📍 ${m.name} - Büyük Deniz (SPACE: Olta | O: Auto-Hunt)`;
    } else {
        locBadge.textContent = `📍 ${m.name}`;
    }

    // Balık Tutma & Auto-Hunt Güncellemesi
    if (autoHunt.active) {
        // Minnkota Otopilot Kontrolü (Akdeniz Haritası & Sarı Bereket Bölgesi Takibi)
        let minnkotaNavigating = false;
        if (player.activeBoatId === 'boat_minnkota' && currentMapId === 'akdeniz') {
            if (autoHunt.navigatingToHotspot) {
                // Sarı Bereket Bölgesi sınırları içine vardık mı veya yolculuk bitti mi?
                if (isInOceanHotspot(player.x, player.y) || player.path.length === 0) {
                    autoHunt.navigatingToHotspot = false;
                    player.path = [];
                    const water = findNearbyWater();
                    if (water && player.equipped.rod) {
                        castFishingLine(water, true);
                        showToast("🎯 [Minnkota Otopilot] Sarı Bereket Bölgesi'ne varıldı! Otomatik avlanma başladı.", '#00f5d4');
                    }
                    updateAutoHuntHUD();
                } else {
                    minnkotaNavigating = true;
                }
            } else if (!isInOceanHotspot(player.x, player.y)) {
                // Sarı bölge dışına çıkılmışsa veya bölge taşınmışsa avlanmayı durdur ve rotayı yeni konuma çevir
                if (fishing.state !== 'IDLE') cancelFishing();
                autoHunt.navigatingToHotspot = true;
                const path = findPath(player.x, player.y, oceanHotspot.x, oceanHotspot.y);
                if (path && path.length > 0) {
                    player.path = path;
                }
                updateAutoHuntHUD();
                showToast("🧭 [Minnkota Otopilot] Sarı Bereket Bölgesi'ne doğru seyre başlandı...", '#ffd166');
                minnkotaNavigating = true;
            }
        }

        if (!minnkotaNavigating) {
            if (fishing.state === 'WAITING') {
                fishing.waitTimer += dt;
                fishing.bobberPhase += dt * 4;
                updateAutoHuntHUD();

                if (fishing.waitTimer >= fishing.waitDuration) {
                    // Otomatik Yakalama (1/3 nadirlik şansı ile)
                    const caught = selectRandomFish(fishing.waterType, true);
                    if (!addItemToInventory(caught.id, 1)) {
                        stopAutoHunt('⚠️ Çantan dolduğu için Auto-Hunt otomatik durduruldu!');
                    } else {
                        if (player.equipped.bait) consumeBait(player.equipped.bait);
                        autoHunt.caughtCount += 1;
                        gainExp(caught.rarity.expGain);
                        gainGuildExp(caught.rarity?.id || caught.rarityKey);
                        showToast(`🤖 [Auto-Hunt] ${caught.name} (${caught.rarity.name}) yakalandı! (+%${caught.rarity.expGain} EXP)`, caught.rarity.color);
                        rollSpecialCraftDrops();
                        fishing.state = 'IDLE';
                        autoHunt.cooldownTimer = 1.0;
                        updateAutoHuntHUD();
                    }
                }
            } else if (fishing.state === 'IDLE') {
                autoHunt.cooldownTimer -= dt;
                if (autoHunt.cooldownTimer <= 0) {
                    const water = findNearbyWater();
                    if (!water || !player.equipped.rod) {
                        stopAutoHunt('Auto-Hunt durdu.');
                    } else {
                        castFishingLine(water, true);
                        updateAutoHuntHUD();
                    }
                }
            }
        }
    } else {
        if (fishing.state === 'WAITING') {
            fishing.waitTimer += dt;
            fishing.bobberPhase += dt * 4;
            if (fishing.waitTimer >= fishing.waitDuration) {
                startFishingMinigame();
            }
        } else if (fishing.state === 'MINIGAME') {
            fishing.cursorPos += fishing.cursorDir * fishing.cursorSpeed * 64 * dt;
            if (fishing.cursorPos >= 98) {
                fishing.cursorPos = 98;
                fishing.cursorDir = -1;
            } else if (fishing.cursorPos <= 2) {
                fishing.cursorPos = 2;
                fishing.cursorDir = 1;
            }
            fishingCursorEl.style.left = `${fishing.cursorPos}%`;
        }
    }
}

function render() {
    const m = getActiveMap();
    ctx.fillStyle = currentMapId === 'burnaz_sahil' ? '#0a2233' : (currentMapId === 'kraken' ? '#220408' : '#132019');
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    const playerIso = tileToScreen(player.x, player.y);
    const camX = viewWidth / 2 - playerIso.x;
    const camY = viewHeight / 2 - playerIso.y;

    ctx.save();
    ctx.translate(camX, camY);

    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
            const t = m.grid[y][x];
            const pos = tileToScreen(x, y);
            const sx = pos.x;
            const sy = pos.y;
            const alt = (x + y) % 2 === 0;

            if (t === TILE.DEEP_SEA) {
                if (currentMapId === 'kraken') {
                    // Kızıl / Kırmızımsı Okyanus Suyu Karosu
                    drawIsoTile(ctx, sx, sy, alt ? '#420b12' : '#33060c', null);

                    // Bolca dalga efekti: Çok katmanlı köpüklü kızıl, pembe ve beyaz dalgalar
                    const wave1 = Math.sin(globalTime * 3.4 + x * 0.85 + y * 0.65);
                    if (wave1 > 0.35) {
                        ctx.strokeStyle = `rgba(255, 170, 180, ${(wave1 * 0.68).toFixed(2)})`;
                        ctx.lineWidth = 2.4;
                        ctx.beginPath();
                        ctx.moveTo(sx - 13, sy - 1);
                        ctx.quadraticCurveTo(sx, sy - 6, sx + 13, sy - 1);
                        ctx.stroke();
                    }
                    const wave2 = Math.cos(globalTime * 2.8 + x * 0.45 - y * 0.75);
                    if (wave2 > 0.5) {
                        ctx.strokeStyle = `rgba(255, 230, 240, ${(wave2 * 0.75).toFixed(2)})`;
                        ctx.lineWidth = 1.8;
                        ctx.beginPath();
                        ctx.moveTo(sx - 9, sy + 3);
                        ctx.quadraticCurveTo(sx, sy - 1, sx + 9, sy + 3);
                        ctx.stroke();
                    }
                    const wave3 = Math.sin(globalTime * 4.2 - x * 0.6 + y * 0.8);
                    if (wave3 > 0.7) {
                        ctx.fillStyle = 'rgba(255, 210, 220, 0.45)';
                        ctx.beginPath();
                        ctx.arc(sx + 5, sy - 2, 2.5, 0, Math.PI * 2);
                        ctx.arc(sx - 7, sy + 2, 2, 0, Math.PI * 2);
                        ctx.fill();
                    }
                } else {
                    drawIsoTile(ctx, sx, sy, alt ? '#0f3966' : '#0d3158', null);
                    const wave = Math.sin(globalTime * 2 + x * 0.7 + y * 0.5);
                    if (wave > 0.82) {
                        ctx.strokeStyle = 'rgba(144, 224, 239, 0.5)';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(sx - 10, sy);
                        ctx.quadraticCurveTo(sx, sy - 4, sx + 10, sy);
                        ctx.stroke();
                    }
                }
            } else if (t === TILE.SEA) {
                drawIsoTile(ctx, sx, sy, alt ? '#0077b6' : '#0088cc', null);
                const nearSand = m.grid[y]?.[x - 1] === TILE.SAND || m.grid[y - 1]?.[x] === TILE.SAND;
                const waveCycle = (globalTime * 1.3 + (x + y) * 0.25) % 3.0;
                if (nearSand && waveCycle < 1.6) {
                    const p = waveCycle / 1.6;
                    const offset = (1 - p) * 12;
                    const alpha = Math.sin(p * Math.PI) * 0.85;
                    ctx.strokeStyle = `rgba(230, 250, 255, ${alpha.toFixed(2)})`;
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.moveTo(sx - 14 - offset, sy - offset * 0.4);
                    ctx.quadraticCurveTo(sx - offset, sy - 5 - offset * 0.4, sx + 12 - offset, sy - offset * 0.4);
                    ctx.stroke();
                }
            } else if (t === TILE.LAKE) {
                drawIsoTile(ctx, sx, sy, alt ? '#2ec4b6' : '#26b3a6', null);
                if (Math.sin(globalTime * 2 + x * 1.4 + y) > 0.82) {
                    ctx.strokeStyle = 'rgba(203, 243, 240, 0.65)';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(sx - 7, sy);
                    ctx.lineTo(sx + 7, sy);
                    ctx.stroke();
                }
            } else if (t === TILE.SAND) {
                drawIsoTile(ctx, sx, sy, alt ? '#f3d592' : '#ecd08c', 'rgba(201,169,98,0.25)', '#c9a962', 3);
            } else if (t === TILE.GRASS) {
                drawIsoTile(ctx, sx, sy, alt ? '#4ea877' : '#469c6d', 'rgba(45,106,79,0.22)', '#2d6a4f', 4);
            } else if (t === TILE.COBBLE) {
                drawIsoTile(ctx, sx, sy, alt ? '#6c757d' : '#606870', 'rgba(33,37,41,0.35)', '#495057', 4);
            } else if (t === TILE.PLAZA) {
                drawIsoTile(ctx, sx, sy, alt ? '#adb5bd' : '#9fa8b0', 'rgba(73,80,87,0.35)', '#6c757d', 5);
            } else if (t === TILE.PIER) {
                drawIsoTile(ctx, sx, sy, '#0077b6', null);
                drawIsoTile(ctx, sx, sy, alt ? '#99582a' : '#8a4f25', 'rgba(67,40,24,0.4)', '#432818', 7);
            }
        }
    }

    if (player.targetMarker) {
        const tm = tileToScreen(player.targetMarker.x, player.targetMarker.y);
        ctx.strokeStyle = '#ffbe0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(tm.x, tm.y - 4, 14, 7, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Kraken Haritasında Suyun Altından Belirip Kaybolan Devasa Kraken Gölgesi
    if (currentMapId === 'kraken') {
        drawKrakenAtmosphereAndShadow(ctx);
    }

    // Akdeniz Haritasında Sarı Bereket Bölgesi (Hotspot - 1.5x Şans Alanı)
    if (currentMapId === 'akdeniz') {
        const hsPos = tileToScreen(oceanHotspot.x, oceanHotspot.y);
        const hsRadiusPx = (GAME_RULES.hotspotRadius || 2.8) * (TILE_W / 2);
        const pulse = Math.sin(globalTime * 3) * 4;

        // Sarı parıldayan su alanı
        const grad = ctx.createRadialGradient(hsPos.x, hsPos.y, 4, hsPos.x, hsPos.y, hsRadiusPx + pulse);
        grad.addColorStop(0, 'rgba(255, 209, 102, 0.45)');
        grad.addColorStop(0.6, 'rgba(255, 190, 11, 0.28)');
        grad.addColorStop(1, 'rgba(255, 190, 11, 0.0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(hsPos.x, hsPos.y, hsRadiusPx + pulse, (hsRadiusPx + pulse) * 0.52, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 209, 102, 0.85)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.ellipse(hsPos.x, hsPos.y, hsRadiusPx + pulse, (hsRadiusPx + pulse) * 0.52, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Üstünde dalgalanan bilgilendirme etiketi
        const remSec = Math.max(0, Math.floor(oceanHotspot.timer));
        const remM = Math.floor(remSec / 60);
        const remS = (remSec % 60).toString().padStart(2, '0');
        drawFloatingLabel(ctx, hsPos.x, hsPos.y - (hsRadiusPx * 0.52) - 10, '🌟 SARI BEREKET BÖLGESİ', `1.5x Değerli Balık Şansı • ${remM}:${remS}`, '#ffd166');
    }

    const renderList = [];

    m.props.forEach(p => {
        const pos = tileToScreen(p.x + 0.5, p.y + 0.5);
        renderList.push({
            depth: p.x + p.y + 1,
            draw: () => drawProp(ctx, p, pos.x, pos.y - 4)
        });
    });

    m.interactables.forEach(inter => {
        const pos = tileToScreen(inter.x, inter.y);
        renderList.push({
            depth: inter.x + inter.y,
            draw: () => drawNPCOrInteractable(ctx, inter, pos.x, pos.y - 4)
        });
    });

    // Çok Oyunculu (Multiplayer) Diğer Oyuncuları Çiz
    if (typeof remotePlayers === 'object' && remotePlayers) {
        Object.values(remotePlayers).forEach(rp => {
            if (rp && rp.mapId === currentMapId) {
                renderList.push({
                    depth: rp.x + rp.y,
                    draw: () => {
                        const rpScreen = tileToScreen(rp.x, rp.y);
                        drawRemotePlayer(ctx, rp, rpScreen.x, rpScreen.y - 4);
                    }
                });
            }
        });
    }

    renderList.push({
        depth: player.x + player.y,
        draw: () => {
            const pScreen = tileToScreen(player.x, player.y);
            drawSmoothCharacter(ctx, pScreen.x, pScreen.y - 4, false);
        }
    });

    renderList.sort((a, b) => a.depth - b.depth);
    renderList.forEach(item => {
        try {
            item.draw();
        } catch (drawErr) {
            console.warn('Render item error:', drawErr);
        }
    });

    if (fishing.state === 'WAITING' || fishing.state === 'MINIGAME') {
        const pScreen = tileToScreen(player.x, player.y);
        const wScreen = tileToScreen(fishing.waterX, fishing.waterY);

        const rodTipX = pScreen.x + 31;
        const rodTipY = pScreen.y - 47;

        const bobOffset = fishing.state === 'MINIGAME'
            ? Math.sin(globalTime * 25) * 4
            : Math.sin(fishing.bobberPhase) * 2;

        const bx = wScreen.x;
        const by = wScreen.y + bobOffset;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.5;
        const rRadius = 8 + ((globalTime * 10) % 10);
        ctx.beginPath();
        ctx.ellipse(bx, by, rRadius, rRadius * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(rodTipX, rodTipY);
        ctx.quadraticCurveTo((rodTipX + bx) / 2, Math.min(rodTipY, by) + 18, bx, by - 4);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(bx, by - 2, 5, 0, Math.PI * 2);
        ctx.fill();
        gCircle(ctx, bx, by - 4, 5, '#ef233c');

        if (fishing.state === 'WAITING') {
            const dots = '.'.repeat(1 + (Math.floor(globalTime * 2) % 3));
            const modeTitle = autoHunt.active ? `🤖 Auto-Hunt Suda${dots}` : `🎣 Olta Suda${dots}`;
            const modeSub = autoHunt.active ? 'Otomatik yakalanacak (4x Süre)' : 'Balık bekleniyor';
            drawFloatingLabel(ctx, pScreen.x, pScreen.y - 68, modeTitle, modeSub, autoHunt.active ? '#80ed99' : '#ffd166');
        } else if (fishing.state === 'MINIGAME') {
            drawFloatingLabel(ctx, pScreen.x, pScreen.y - 68, '❗ BALIK VURDU!', 'SPACE tuşuna bas!', '#ff006e');
        }
    }

    ctx.restore();

    const charCreateModal = document.getElementById('char-create-modal');
    if (charCreateModal && !charCreateModal.classList.contains('hidden')) {
        renderCharCreationPreview();
    }
}

function gCircle(g, x, y, r, color) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, Math.PI, 0);
    g.fill();
}

let lastTime = performance.now();
function gameLoop(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    update(dt);
    render();
    requestAnimationFrame(gameLoop);
}

const closeGuildBtn = document.getElementById('close-guild-btn');
if (closeGuildBtn) {
    closeGuildBtn.onclick = () => {
        document.getElementById('guild-modal').classList.add('hidden');
    };
}

const hudGuildBtn = document.getElementById('hud-guild-btn');
if (hudGuildBtn) {
    hudGuildBtn.onclick = () => {
        toggleGuildWindow();
    };
}

// Dörtyol Karargâhı'na Dönüş Fonksiyonu (Lider dönerse lonca seferi biter, üye dönerse tek başına döner)
function returnFromKrakenToDortyol() {
    if (currentMapId !== 'kraken') return;
    if (typeof cancelFishing === 'function') cancelFishing();
    if (autoHunt && autoHunt.active && typeof stopAutoHunt === 'function') {
        stopAutoHunt("Dörtyol'a döndüğün için Auto-Hunt durduruldu.");
    }
    const wasLeader = isPlayerGuildLeader();
    currentMapId = 'dortyol';
    player.x = 21.5;
    player.y = 7.5;
    player.path = [];
    if (wasLeader) {
        if (activeGuild) {
            activeGuild.krakenActive = false;
            saveGuildData();
        }
        showToast("🏰 Lonca Lideri olarak Dörtyol Karargâhı'na döndün. Kraken seferi tamamlandı.", '#80ed99');
        if (typeof addChatMessage === 'function') {
            addChatMessage('Lonca', `[${player.name}] (Lonca Lideri) Dörtyol'a döndü. Kraken seferi sonlandı.`, 'system');
        }
    } else {
        showToast("🏰 Tek başına Dörtyol Karargâhı'na döndün. Diğer lonca üyeleri teknede avlanmaya devam ediyor!", '#80ed99');
        if (typeof addChatMessage === 'function') {
            addChatMessage('Lonca', `[${player.name}] tekneden ayrılarak Dörtyol'a döndü. Lonca seferi devam ediyor.`, 'system');
        }
    }
}

// Güvenli Tıklama Dinleyicisi (Delegated Click)
document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'kraken-return-btn' || e.target.closest('#kraken-return-btn'))) {
        e.stopPropagation();
        e.preventDefault();
        returnFromKrakenToDortyol();
    }
});

// ============================================================================
// ÇOK OYUNCULU (MULTIPLAYER) KARAKTER ÇİZİMİ
// ============================================================================
function drawRemotePlayer(g, rp, x, y) {
    if (!rp) return;
    const costume = rp.costume ? ITEMS[rp.costume] : null;
    const shirtColor = costume ? costume.shirt : '#6c757d';
    const vestColor = costume ? costume.vest : '#495057';
    const pantsColor = costume ? costume.pants : '#2b2d42';
    const hatType = costume ? costume.hat : 'none';

    // 1. Gölge
    g.fillStyle = 'rgba(0, 0, 0, 0.28)';
    g.beginPath();
    g.ellipse(x, y + 2, 12, 5, 0, 0, Math.PI * 2);
    g.fill();

    // 2. Bacaklar / Pantolon
    const bodyY = y - 10;
    g.fillStyle = pantsColor;
    g.beginPath();
    g.roundRect(x - 6, bodyY + 14, 5, 10, 2);
    g.roundRect(x + 1, bodyY + 14, 5, 10, 2);
    g.fill();

    // 3. Gövde & Yelek
    g.fillStyle = shirtColor;
    g.beginPath();
    g.roundRect(x - 9, bodyY, 18, 16, 4);
    g.fill();

    g.fillStyle = vestColor;
    g.beginPath();
    g.roundRect(x - 9, bodyY + 1, 6, 16, 3);
    g.roundRect(x + 3, bodyY + 1, 6, 16, 3);
    g.fill();

    // 4. Baş
    const headY = bodyY - 12;
    g.fillStyle = '#ffcdb2';
    g.beginPath();
    g.arc(x, headY, 10.5, 0, Math.PI * 2);
    g.fill();

    // Gözler
    const lookRight = (rp.dirX >= rp.dirY);
    const eyeOffsetX = lookRight ? 2.5 : -2.5;
    g.fillStyle = '#1d1e2c';
    g.beginPath();
    g.arc(x - 3.5 + eyeOffsetX, headY + 1, 1.8, 0, Math.PI * 2);
    g.arc(x + 3.5 + eyeOffsetX, headY + 1, 1.8, 0, Math.PI * 2);
    g.fill();

    // Şapka
    if (hatType === 'straw') {
        g.fillStyle = '#e9c46a';
        g.beginPath();
        g.ellipse(x, headY - 6, 16, 5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#f4a261';
        g.beginPath();
        g.arc(x, headY - 7, 9.5, Math.PI, 0);
        g.fill();
    } else if (hatType === 'pirate' || hatType === 'feather_pirate') {
        g.fillStyle = '#1d1e2c';
        g.beginPath();
        g.moveTo(x - 16, headY - 5);
        g.quadraticCurveTo(x, headY - 19, x + 16, headY - 5);
        g.closePath();
        g.fill();
        g.fillStyle = '#ffbe0b';
        g.beginPath();
        g.arc(x, headY - 9, 3, 0, Math.PI * 2);
        g.fill();
    } else if (hatType === 'royal_helm') {
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.arc(x, headY - 4, 11, Math.PI, 0);
        g.fill();
    } else {
        g.fillStyle = '#582f0e';
        g.beginPath();
        g.arc(x, headY - 3, 10.5, Math.PI, 0);
        g.fill();
    }

    // 5. Olta (Balık Tutuyorsa)
    if (rp.isFishing) {
        g.strokeStyle = '#ffd166';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(x + 9, bodyY + 9);
        g.lineTo(x + 28, bodyY - 15);
        g.stroke();
    }

    // 6. Baş Üstü İsimlik & Seviye & GM Rozeti
    const isGM = (rp.role === 'admin');
    const lvTag = `Lv.${rp.level || 1}`;
    const nameStr = (isGM ? '👑 ' : '') + (rp.name || 'Gezgin');

    g.save();
    g.font = 'bold 11px "Segoe UI", sans-serif';
    const lvW = g.measureText(lvTag).width;
    const nameW = g.measureText(nameStr).width;
    const tagW = lvW + nameW + 16;
    const tagH = 18;
    const tagX = x - tagW / 2;
    const tagY = headY - 24;

    g.fillStyle = 'rgba(10, 16, 26, 0.85)';
    g.strokeStyle = isGM ? '#ffd166' : 'rgba(76, 201, 240, 0.55)';
    g.lineWidth = isGM ? 1.5 : 1.2;
    g.beginPath();
    g.roundRect(tagX, tagY, tagW, tagH, 9);
    g.fill();
    g.stroke();

    g.fillStyle = isGM ? '#ffd166' : '#4cc9f0';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(lvTag, tagX + 7, tagY + tagH / 2);

    g.fillStyle = isGM ? '#fff3b0' : '#ffffff';
    g.fillText(nameStr, tagX + 7 + lvW + 4, tagY + tagH / 2);

    // Lonca İsmi (Varsa)
    if (rp.guildName) {
        g.font = 'bold 10px "Segoe UI", sans-serif';
        const gTag = `< ${rp.guildName} >`;
        g.fillStyle = '#ffbe0b';
        g.textAlign = 'center';
        g.fillText(gTag, x, tagY - 8);
    }

    g.restore();
}

// ============================================================================
// YÖNETİCİ (GM) & KONTROL PANELİ YETKİLENDİRMESİ
// ============================================================================
function updateAdminPrivileges() {
    const isAdmin = Boolean(currentUser && currentUser.role === 'admin');
    player.isAdmin = isAdmin;

    const hudAdminBtn = document.getElementById('hud-admin-btn');
    if (hudAdminBtn) {
        hudAdminBtn.classList.toggle('hidden', !isAdmin);
    }
    const hintPill = document.getElementById('hint-admin-pill');
    const hintDiv = document.getElementById('hint-admin-divider');
    const hintTxt = document.getElementById('hint-admin-text');
    if (hintPill) hintPill.classList.toggle('hidden', !isAdmin);
    if (hintDiv) hintDiv.classList.toggle('hidden', !isAdmin);
    if (hintTxt) hintTxt.classList.toggle('hidden', !isAdmin);

    const accNameEl = document.getElementById('hud-account-name');
    if (accNameEl) {
        if (currentUser) {
            accNameEl.textContent = `${isAdmin ? '👑 GM ' : '👤 '}${currentUser.username}`;
            if (accNameEl.parentElement) {
                accNameEl.parentElement.title = `Hesap: ${currentUser.username} (${isAdmin ? 'Yönetici / GM' : 'Oyuncu'}) • Tıkla: Çıkış Yap`;
            }
        } else {
            accNameEl.textContent = '👤 Giriş';
            if (accNameEl.parentElement) {
                accNameEl.parentElement.title = 'Giriş Yap / Hesap Değiştir';
            }
        }
    }
}

// ============================================================================
// HESAP VERİLERİ VE BULUT KAYIT ENTEGRASYONU
// ============================================================================
function applyLoadedCharacter(c) {
    if (!c) return;
    if (c.name) player.name = c.name;
    if (c.level !== undefined) player.level = c.level;
    if (c.exp !== undefined) player.exp = c.exp;
    if (c.gold !== undefined) player.gold = c.gold;
    if (c.skillPoints !== undefined) player.skillPoints = c.skillPoints;
    if (c.skills) Object.assign(player.skills, c.skills);
    if (c.equipped) Object.assign(player.equipped, c.equipped);
    if (Array.isArray(c.inventory)) player.inventory = c.inventory;
    if (Array.isArray(c.storage)) player.storage = c.storage;
    if (Array.isArray(c.ownedBoats)) player.ownedBoats = c.ownedBoats;
    if (c.activeBoatId) player.activeBoatId = c.activeBoatId;
    if (c.rodEnchants) Object.assign(player.rodEnchants, c.rodEnchants);
    if (c.costumeEnchants) Object.assign(player.costumeEnchants, c.costumeEnchants);
    if (c.guildName) {
        player.guildName = c.guildName;
        SafeStorage.setItem('mmo_player_guild', c.guildName);
    }
    if (c.x && c.y && c.mapId) {
        currentMapId = c.mapId;
        player.x = Number(c.x);
        player.y = Number(c.y);
    }
    SafeStorage.setItem('mmo_character_name', player.name);
    updateExpHUD();
    updateInventoryBadge();
    renderBuffBar();
}

async function saveCharacterToServer() {
    if (!serverOnline || !authToken || !currentUser || !player.name) return;
    const payload = {
        name: player.name,
        level: player.level,
        exp: player.exp,
        gold: player.gold,
        skillPoints: player.skillPoints,
        skills: player.skills,
        equipped: player.equipped,
        inventory: player.inventory,
        storage: player.storage,
        ownedBoats: player.ownedBoats,
        activeBoatId: player.activeBoatId,
        rodEnchants: player.rodEnchants,
        costumeEnchants: player.costumeEnchants,
        guildName: player.guildName,
        x: Number(player.x.toFixed(2)),
        y: Number(player.y.toFixed(2)),
        mapId: currentMapId
    };

    try {
        await fetch(getServerApiUrl('/api/character/save'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ characterData: payload })
        });
    } catch (e) {
        console.warn('Buluta kaydetme hatası:', e);
    }
}

// 20 Saniyede Bir Otomatik Bulut Kaydı
setInterval(saveCharacterToServer, 20000);
window.addEventListener('beforeunload', saveCharacterToServer);

// ============================================================================
// ÇOK OYUNCULU AĞ (SOCKET.IO) BAĞLANTISI
// ============================================================================
function initSocketConnection() {
    if (typeof io === 'undefined') return;
    if (socket && socket.connected) return;

    try {
        const socketTarget = getServerApiUrl('');
        socket = socketTarget ? io(socketTarget) : io();

        socket.on('connect', () => {
            socket.emit('player_join', {
                token: authToken,
                charName: player.name,
                x: player.x,
                y: player.y,
                mapId: currentMapId,
                costume: player.equipped.costume,
                boatId: (currentMapId === 'akdeniz' || currentMapId === 'kraken') ? player.activeBoatId : null,
                level: player.level,
                guildName: player.guildName
            });
        });

        socket.on('map_peers', (peers) => {
            remotePlayers = {};
            if (Array.isArray(peers)) {
                peers.forEach(p => {
                    remotePlayers[p.socketId] = p;
                });
            }
        });

        socket.on('player_joined', (p) => {
            if (p && p.socketId) {
                remotePlayers[p.socketId] = p;
                addChatMessage('Sistem', `[${p.name}] haritaya geldi.`, 'system');
            }
        });

        socket.on('player_moved', (data) => {
            if (remotePlayers[data.socketId]) {
                Object.assign(remotePlayers[data.socketId], data);
            }
        });

        socket.on('player_left', (socketId) => {
            if (remotePlayers[socketId]) {
                delete remotePlayers[socketId];
            }
        });

        socket.on('chat_broadcast', (msg) => {
            if (msg.sender === player.name) return;
            const isSenderAdmin = (msg.role === 'admin');
            const senderDisplay = isSenderAdmin ? `👑 [GM] ${msg.sender}` : msg.sender;
            addChatMessage(senderDisplay, msg.text, isSenderAdmin ? 'admin' : 'player');
            if (msg.socketId && remotePlayers[msg.socketId]) {
                remotePlayers[msg.socketId].chatBubble = { text: msg.text, timer: 6.0 };
            }
        });

        socket.on('online_count', (count) => {
            const statusEl = document.getElementById('auth-status-text');
            if (statusEl && serverOnline) {
                statusEl.textContent = `Sunucu: 🟢 Çevrimiçi (${count} Oyuncu)`;
            }
        });
    } catch (e) {
        console.warn('Socket başlatma hatası:', e);
    }
}

// ============================================================================
// GİRİŞ & KAYIT AĞ GEÇİDİ (AUTH GATEWAY ARAYÜZ YÖNETİMİ)
// ============================================================================
function showAuthError(errElement, message) {
    if (!errElement) return;
    errElement.textContent = message;
    errElement.classList.remove('hidden');
}

function clearAuthErrors() {
    const errLogin = document.getElementById('auth-login-error');
    const errReg = document.getElementById('auth-reg-error');
    if (errLogin) errLogin.classList.add('hidden');
    if (errReg) errReg.classList.add('hidden');
}

function openAuthGateway() {
    const modal = document.getElementById('auth-gateway-modal');
    if (modal) modal.classList.remove('hidden');
    clearAuthErrors();
}

function closeAuthGateway() {
    const modal = document.getElementById('auth-gateway-modal');
    if (modal) modal.classList.add('hidden');
    clearAuthErrors();
}

async function checkServerStatus() {
    const dot = document.getElementById('auth-status-dot');
    const txt = document.getElementById('auth-status-text');

    const tryUrl = getServerApiUrl('/api/status');
    try {
        const res = await fetch(tryUrl, { method: 'GET', cache: 'no-cache' });
        if (res.ok) {
            let data = null;
            try { data = await res.json(); } catch (e) {}
            if (data && data.online) {
                serverOnline = true;
                if (dot) dot.className = 'auth-status-dot online';
                if (txt) txt.textContent = `Sunucu: 🟢 Çevrimiçi (${data.onlinePlayers || 0} Oyuncu Aktif)`;
                return true;
            }
        }
    } catch (e) {
        // Eğer localhost:3000 denendiyse ve relative url farklıysa relative url dene
        if (tryUrl.startsWith('http://localhost:3000') && window.location.protocol !== 'file:') {
            try {
                const res2 = await fetch('/api/status', { method: 'GET', cache: 'no-cache' });
                if (res2.ok) {
                    let data2 = null;
                    try { data2 = await res2.json(); } catch (e2) {}
                    if (data2 && data2.online) {
                        serverOnline = true;
                        if (dot) dot.className = 'auth-status-dot online';
                        if (txt) txt.textContent = `Sunucu: 🟢 Çevrimiçi (${data2.onlinePlayers || 0} Oyuncu Aktif)`;
                        return true;
                    }
                }
            } catch (e2) {}
        }
    }

    serverOnline = false;
    if (dot) dot.className = 'auth-status-dot offline';
    if (txt) txt.textContent = 'Sunucu Durumu: ⚡ Yerel / Bağımsız Mod';
    return false;
}

async function tryAutoLogin() {
    if (!authToken) return false;
    try {
        const res = await fetch(getServerApiUrl('/api/auth/me'), {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            let data = null;
            try { data = await res.json(); } catch (e) {}
            if (data && data.success && data.user) {
                currentUser = data.user;
                updateAdminPrivileges();
                if (data.character) {
                    applyLoadedCharacter(data.character);
                    closeAuthGateway();
                    initSocketConnection();
                    showToast(`👋 Tekrar hoş geldin, ${player.name}!`, '#80ed99');
                    return true;
                } else {
                    closeAuthGateway();
                    openCharacterCreation();
                    return true;
                }
            }
        }
    } catch (e) {
        console.warn('Otomatik giriş denenirken hata:', e);
    }
    return false;
}

async function handleLoginSubmit() {
    const identInput = document.getElementById('auth-login-ident');
    const passInput = document.getElementById('auth-login-pass');
    const rememberChk = document.getElementById('auth-login-remember');
    const errBox = document.getElementById('auth-login-error');
    const submitBtn = document.getElementById('auth-btn-login');

    const username = (identInput?.value || '').trim();
    const password = passInput?.value || '';

    if (!username || !password) {
        showAuthError(errBox, 'Lütfen kullanıcı adı veya e-postanızı ve şifrenizi girin!');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.6';
    }

    if (serverOnline) {
        try {
            const res = await fetch(getServerApiUrl('/api/auth/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            let data = null;
            try {
                data = await res.json();
            } catch (jsonErr) {
                data = null;
            }

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }

            if (!res.ok || !data || !data.success) {
                showAuthError(errBox, (data && data.message) ? data.message : `Giriş başarısız oldu (Hata Kodu: ${res.status}).`);
                return;
            }

            currentUser = data.user;
            authToken = data.token;
            if (rememberChk && rememberChk.checked) {
                SafeStorage.setItem('mmo_auth_token', authToken);
            } else {
                SafeStorage.removeItem('mmo_auth_token');
            }

            saveLocalAccount(currentUser.username, currentUser.email, password, currentUser.role);
            updateAdminPrivileges();

            if (data.character) {
                applyLoadedCharacter(data.character);
                closeAuthGateway();
                initSocketConnection();
                showToast(`⚔️ Hoş geldin, ${player.name}! Dünyaya bağlandın.`, '#80ed99');
            } else {
                closeAuthGateway();
                openCharacterCreation();
            }
            return;
        } catch (err) {
            console.warn('Giriş sunucu isteği başarısız oldu:', err);
            // Sunucuya ulaşılamadıysa yerel hesap eşleşmesi var mı kontrol et
            const localAcc = findLocalAccount(username);
            if (localAcc) {
                if (localAcc.password && localAcc.password !== password) {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.style.opacity = '1';
                    }
                    showAuthError(errBox, 'Şifre hatalı! (Yerel hesap eşleşmesi)');
                    return;
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.style.opacity = '1';
                }
                currentUser = { id: 1, username: localAcc.username, email: localAcc.email, role: localAcc.role };
                updateAdminPrivileges();
                const savedName = SafeStorage.getItem('mmo_character_name');
                closeAuthGateway();
                if (savedName) {
                    player.name = savedName;
                    showToast(`⚡ Sunucu çevrimdışı. Yerel hesapla devam ediliyor (${player.name})!`, '#ffd166');
                } else {
                    openCharacterCreation();
                }
                return;
            }

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
            showAuthError(errBox, 'Sunucuya bağlanılamadı. Node.js sunucusunun açık olduğundan veya internet bağlantınızdan emin olun. Dilerseniz hemen alttaki "Çevrimdışı / Yerel Oyna" butonuna tıklayarak oyuna başlayabilirsiniz.');
            return;
        }
    } else {
        // Yerel Çevrimdışı Mod
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        }
        const localAcc = findLocalAccount(username);
        if (localAcc && localAcc.password && localAcc.password !== password) {
            showAuthError(errBox, 'Şifre hatalı!');
            return;
        }

        const isLocalAdmin = (username.toLowerCase() === 'burak' || username.toLowerCase() === 'admin' || (localAcc && localAcc.role === 'admin'));
        const userEmail = localAcc ? localAcc.email : 'local@mmo.local';
        currentUser = { id: 1, username, email: userEmail, role: isLocalAdmin ? 'admin' : 'player' };
        saveLocalAccount(username, userEmail, password, currentUser.role);
        updateAdminPrivileges();
        const savedName = SafeStorage.getItem('mmo_character_name');
        closeAuthGateway();
        if (savedName) {
            player.name = savedName;
            showToast(`⚡ Yerel Mod: Hoş geldin, ${player.name}!`, '#ffd166');
        } else {
            openCharacterCreation();
        }
    }
}

async function handleRegisterSubmit() {
    const userInput = document.getElementById('auth-reg-user');
    const emailInput = document.getElementById('auth-reg-email');
    const passInput = document.getElementById('auth-reg-pass');
    const pass2Input = document.getElementById('auth-reg-pass2');
    const errBox = document.getElementById('auth-reg-error');
    const submitBtn = document.getElementById('auth-btn-register');

    const username = (userInput?.value || '').trim();
    const email = (emailInput?.value || '').trim();
    const password = passInput?.value || '';
    const password2 = pass2Input?.value || '';

    if (!username || !email || !password || !password2) {
        showAuthError(errBox, 'Lütfen tüm alanları eksiksiz doldurun!');
        return;
    }

    if (username.length < 3 || username.length > 16) {
        showAuthError(errBox, 'Kullanıcı adı 3 ile 16 karakter arasında olmalıdır!');
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showAuthError(errBox, 'Lütfen geçerli bir e-posta adresi girin!');
        return;
    }

    if (password.length < 4) {
        showAuthError(errBox, 'Şifre en az 4 karakterden oluşmalıdır!');
        return;
    }

    if (password !== password2) {
        showAuthError(errBox, 'Girdiğiniz şifreler birbiriyle eşleşmiyor!');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.6';
    }

    if (serverOnline) {
        try {
            const res = await fetch(getServerApiUrl('/api/auth/register'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, email, password })
            });
            let data = null;
            try {
                data = await res.json();
            } catch(e) {
                data = null;
            }

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }

            if (!res.ok || !data || !data.success) {
                showAuthError(errBox, (data && data.message) ? data.message : `Hesap oluşturulamadı (Hata: ${res.status})!`);
                return;
            }

            currentUser = data.user;
            authToken = data.token;
            SafeStorage.setItem('mmo_auth_token', authToken);
            saveLocalAccount(username, email, password, currentUser.role);
            updateAdminPrivileges();

            showToast(data.message || '🎉 Hesabınız oluşturuldu!', '#80ed99');
            closeAuthGateway();
            openCharacterCreation();
            return;
        } catch (err) {
            console.warn('Sunucuya kayıt isteği başarısız oldu, yerel kayıt deneniyor:', err);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
            const isLocalAdmin = (username.toLowerCase() === 'burak' || username.toLowerCase() === 'admin');
            currentUser = { id: 1, username, email, role: isLocalAdmin ? 'admin' : 'player' };
            saveLocalAccount(username, email, password, currentUser.role);
            updateAdminPrivileges();
            closeAuthGateway();
            openCharacterCreation();
            showToast('⚡ Sunucu çevrimdışı: Hesabınız yerel olarak oluşturuldu!', '#ffd166');
            return;
        }
    } else {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        }
        const isLocalAdmin = (username.toLowerCase() === 'burak' || username.toLowerCase() === 'admin');
        currentUser = { id: 1, username, email, role: isLocalAdmin ? 'admin' : 'player' };
        saveLocalAccount(username, email, password, currentUser.role);
        updateAdminPrivileges();
        closeAuthGateway();
        openCharacterCreation();
        showToast('🎉 Hesabınız yerel modda oluşturuldu! Şimdi karakterinizi yaratın.', '#80ed99');
    }
}

function logoutUser() {
    if (!confirm('Hesabınızdan çıkış yapmak istediğinize emin misiniz?')) return;
    saveCharacterToServer();
    authToken = null;
    currentUser = null;
    SafeStorage.removeItem('mmo_auth_token');
    updateAdminPrivileges();
    if (socket) {
        try { socket.disconnect(); } catch (e) {}
    }
    openAuthGateway();
    showToast('Çıkış yapıldı. Tekrar görüşmek üzere!', '#ffd166');
}

function initAuthGatewaySystem() {
    const tabLogin = document.getElementById('auth-tab-btn-login');
    const tabRegister = document.getElementById('auth-tab-btn-register');
    const formLogin = document.getElementById('auth-login-form');
    const formRegister = document.getElementById('auth-register-form');

    if (tabLogin && tabRegister && formLogin && formRegister) {
        tabLogin.onclick = () => {
            tabLogin.classList.add('active');
            tabRegister.classList.remove('active');
            formLogin.classList.remove('hidden');
            formRegister.classList.add('hidden');
            clearAuthErrors();
        };

        tabRegister.onclick = () => {
            tabRegister.classList.add('active');
            tabLogin.classList.remove('active');
            formRegister.classList.remove('hidden');
            formLogin.classList.add('hidden');
            clearAuthErrors();
        };
    }

    const btnLogin = document.getElementById('auth-btn-login');
    if (btnLogin) btnLogin.onclick = handleLoginSubmit;

    const btnRegister = document.getElementById('auth-btn-register');
    if (btnRegister) btnRegister.onclick = handleRegisterSubmit;

    const btnOffline = document.getElementById('auth-btn-offline');
    if (btnOffline) {
        btnOffline.onclick = () => {
            const identInput = document.getElementById('auth-login-ident');
            const raw = (identInput?.value || '').trim() || 'Balıkçı';
            const isBurak = (raw.toLowerCase() === 'burak' || raw.toLowerCase() === 'admin');
            currentUser = { id: 1, username: raw, email: 'local@mmo.local', role: isBurak ? 'admin' : 'player' };
            updateAdminPrivileges();
            const savedName = SafeStorage.getItem('mmo_character_name');
            closeAuthGateway();
            if (savedName) {
                player.name = savedName;
                showToast(`⚡ Çevrimdışı Mod: Hoş geldin, ${player.name}!`, '#ffd166');
            } else {
                openCharacterCreation();
            }
        };
    }

    const serverSettingsBtn = document.getElementById('auth-server-settings-btn');
    const serverConfigRow = document.getElementById('auth-server-config-row');
    const customServerInput = document.getElementById('auth-custom-server-input');
    const saveServerBtn = document.getElementById('auth-save-server-btn');
    const resetServerBtn = document.getElementById('auth-reset-server-btn');

    if (customServerInput) {
        customServerInput.value = SafeStorage.getItem('mmo_server_url') || '';
    }

    if (serverSettingsBtn && serverConfigRow) {
        serverSettingsBtn.onclick = () => {
            serverConfigRow.classList.toggle('hidden');
        };
    }

    if (saveServerBtn && customServerInput) {
        saveServerBtn.onclick = () => {
            const val = customServerInput.value.trim();
            if (val) {
                SafeStorage.setItem('mmo_server_url', val);
                showToast(`🌐 Sunucu adresi kaydedildi: ${val}`, '#80ed99');
            } else {
                SafeStorage.removeItem('mmo_server_url');
                showToast('🌐 Otomatik sunucu moduna geçildi.', '#ffd166');
            }
            if (serverConfigRow) serverConfigRow.classList.add('hidden');
            checkServerStatus();
        };
    }

    if (resetServerBtn && customServerInput) {
        resetServerBtn.onclick = () => {
            customServerInput.value = '';
            SafeStorage.removeItem('mmo_server_url');
            showToast('🌐 Varsayılan sunucu adresine dönüldü.', '#ffd166');
            if (serverConfigRow) serverConfigRow.classList.add('hidden');
            checkServerStatus();
        };
    }

    const loginPass = document.getElementById('auth-login-pass');
    if (loginPass) {
        loginPass.addEventListener('keydown', (e) => {
            if (e.code === 'Enter') {
                e.preventDefault();
                handleLoginSubmit();
            }
        });
    }

    const regPass2 = document.getElementById('auth-reg-pass2');
    if (regPass2) {
        regPass2.addEventListener('keydown', (e) => {
            if (e.code === 'Enter') {
                e.preventDefault();
                handleRegisterSubmit();
            }
        });
    }

    const hudAccountBtn = document.getElementById('hud-account-btn');
    if (hudAccountBtn) {
        hudAccountBtn.onclick = () => {
            if (currentUser) {
                logoutUser();
            } else {
                openAuthGateway();
            }
        };
    }

    // Sunucu durumunu kontrol et ve varsa oturumu devam ettir
    checkServerStatus().then(online => {
        if (online) {
            tryAutoLogin().then(loggedIn => {
                if (!loggedIn) {
                    openAuthGateway();
                }
            });
        } else {
            // Sunucu yoksa veya yerel moddaysa
            const savedName = SafeStorage.getItem('mmo_character_name');
            if (savedName) {
                player.name = savedName;
                const isLocalAdmin = (savedName.toLowerCase() === 'burak' || savedName.toLowerCase() === 'admin');
                currentUser = { id: 1, username: savedName, email: 'local@mmo.local', role: isLocalAdmin ? 'admin' : 'player' };
                updateAdminPrivileges();
                closeAuthGateway();
            } else {
                openAuthGateway();
            }
        }
    });
}

initWikiSystem();
initChatSystem();
initCharacterCreationModal();
sanitizeVaultAndInventoryCostumes();
initAuthGatewaySystem();
isGameReady = true;
requestAnimationFrame(gameLoop);
