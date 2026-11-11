const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const initSqlJs = require('sql.js');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'arena.db');
const LEGACY_PROFILE_FILE = path.join(__dirname, 'profiles.json');
const SQL_WASM_FILE = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let db = null;

function persistDatabase() {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function runStatement(sql, params) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
    persistDatabase();
}

function runStatementNoPersist(sql, params) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
}

function getOne(sql, params) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
}

function getAll(sql, params) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

function createSchema() {
    db.exec(
        "PRAGMA foreign_keys = ON;" +
        "CREATE TABLE IF NOT EXISTS users (" +
        "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  username TEXT UNIQUE NOT NULL," +
        "  password_hash TEXT NOT NULL," +
        "  created_at TEXT DEFAULT CURRENT_TIMESTAMP," +
        "  last_login_at TEXT" +
        ");" +
        "CREATE TABLE IF NOT EXISTS profiles (" +
        "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  username TEXT UNIQUE NOT NULL," +
        "  display_name TEXT NOT NULL," +
        "  email TEXT," +
        "  region TEXT," +
        "  preferred_role TEXT," +
        "  updated_at TEXT DEFAULT CURRENT_TIMESTAMP" +
        ");" +
        "CREATE TABLE IF NOT EXISTS user_settings (" +
        "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  username TEXT UNIQUE NOT NULL," +
        "  show_online_status INTEGER DEFAULT 1," +
        "  match_invites INTEGER DEFAULT 1," +
        "  rank_notifications INTEGER DEFAULT 1," +
        "  streamer_mode INTEGER DEFAULT 0," +
        "  two_factor_enabled INTEGER DEFAULT 1," +
        "  promotional_emails INTEGER DEFAULT 0," +
        "  updated_at TEXT DEFAULT CURRENT_TIMESTAMP" +
        ");" +
        "CREATE TABLE IF NOT EXISTS frenzy_scores (" +
        "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  username TEXT NOT NULL," +
        "  score INTEGER NOT NULL," +
        "  max_combo INTEGER NOT NULL," +
        "  bonuses INTEGER NOT NULL DEFAULT 0," +
        "  created_at TEXT DEFAULT CURRENT_TIMESTAMP," +
        "  FOREIGN KEY (username) REFERENCES users(username) ON UPDATE CASCADE ON DELETE CASCADE" +
        ");" +
        "CREATE INDEX IF NOT EXISTS idx_frenzy_scores_username_score ON frenzy_scores(username, score DESC);" +
        "CREATE INDEX IF NOT EXISTS idx_frenzy_scores_score ON frenzy_scores(score DESC);"
    );
    persistDatabase();
}

function seedDefaultRecords(username) {
    runStatement(
        'INSERT OR IGNORE INTO profiles (username, display_name, email, region, preferred_role) VALUES (?, ?, ?, ?, ?)',
        [username, username, '', 'Asia / Mumbai', 'Entry Fragger']
    );

    runStatement(
        'INSERT OR IGNORE INTO user_settings (username) VALUES (?)',
        [username]
    );
}

function migrateLegacyProfiles() {
    if (!fs.existsSync(LEGACY_PROFILE_FILE)) {
        return;
    }

    const raw = fs.readFileSync(LEGACY_PROFILE_FILE, 'utf8');
    const legacyProfiles = JSON.parse(raw);

    Object.keys(legacyProfiles).forEach(function (username) {
        const profile = legacyProfiles[username] || {};
        runStatement(
            'INSERT OR REPLACE INTO profiles (username, display_name, email, region, preferred_role, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [
                username,
                profile.displayName || profile.display_name || username,
                profile.email || '',
                profile.region || 'Asia / Mumbai',
                profile.preferredRole || profile.preferred_role || 'Entry Fragger'
            ]
        );
    });
}

function ensureUserExists(username) {
    return getOne('SELECT username FROM users WHERE username = ?', [username]);
}

function resolveAccountIdentity(identity) {
    const user = getOne('SELECT username FROM users WHERE username = ?', [identity]);
    if (user) {
        return user.username;
    }

    const profile = getOne(
        'SELECT username FROM profiles WHERE username = ? OR display_name = ? LIMIT 1',
        [identity, identity]
    );

    return profile ? profile.username : null;
}

function renameUserIdentity(oldUsername, newUsername) {
    if (oldUsername === newUsername) {
        return;
    }

    db.run('BEGIN TRANSACTION');

    try {
        runStatementNoPersist('UPDATE users SET username = ? WHERE username = ?', [newUsername, oldUsername]);
        runStatementNoPersist(
            'UPDATE profiles SET username = ?, display_name = ? WHERE username = ?',
            [newUsername, newUsername, oldUsername]
        );
        runStatementNoPersist(
            'UPDATE user_settings SET username = ? WHERE username = ?',
            [newUsername, oldUsername]
        );
        runStatementNoPersist(
            'INSERT OR IGNORE INTO user_settings (username) VALUES (?)',
            [newUsername]
        );

        db.run('COMMIT');
        persistDatabase();
    } catch (error) {
        db.run('ROLLBACK');
        throw error;
    }
}

function getProfile(username) {
    const profile = getOne(
        'SELECT username, display_name, email, region, preferred_role FROM profiles WHERE username = ?',
        [username]
    );

    return profile || {
        username: username,
        display_name: username,
        email: '',
        region: 'Asia / Mumbai',
        preferred_role: 'Entry Fragger'
    };
}

function getUserSettings(username) {
    const settings = getOne(
        'SELECT username, show_online_status, match_invites, rank_notifications, streamer_mode, two_factor_enabled, promotional_emails FROM user_settings WHERE username = ?',
        [username]
    );

    return settings || {
        username: username,
        show_online_status: 1,
        match_invites: 1,
        rank_notifications: 1,
        streamer_mode: 0,
        two_factor_enabled: 1,
        promotional_emails: 0
    };
}

function saveProfile(username, data) {
    runStatement(
        'INSERT INTO profiles (username, display_name, email, region, preferred_role, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, email = excluded.email, region = excluded.region, preferred_role = excluded.preferred_role, updated_at = CURRENT_TIMESTAMP',
        [username, data.displayName, data.email, data.region, data.preferredRole]
    );
}

function saveUserSettings(username, data) {
    runStatement(
        'INSERT INTO user_settings (username, show_online_status, match_invites, rank_notifications, streamer_mode, two_factor_enabled, promotional_emails, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(username) DO UPDATE SET show_online_status = excluded.show_online_status, match_invites = excluded.match_invites, rank_notifications = excluded.rank_notifications, streamer_mode = excluded.streamer_mode, two_factor_enabled = excluded.two_factor_enabled, promotional_emails = excluded.promotional_emails, updated_at = CURRENT_TIMESTAMP',
        [
            username,
            data.showOnlineStatus,
            data.matchInvites,
            data.rankNotifications,
            data.streamerMode,
            data.twoFactorEnabled,
            data.promotionalEmails
        ]
    );
}

function getFrenzyLeaderboard(limit) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
    const rows = getAll(
        "SELECT fs.username, p.display_name, MAX(fs.score) AS top_score, MAX(fs.max_combo) AS top_combo " +
        "FROM frenzy_scores fs " +
        "INNER JOIN users u ON u.username = fs.username " +
        "LEFT JOIN profiles p ON p.username = fs.username " +
        "GROUP BY fs.username, p.display_name " +
        "ORDER BY top_score DESC, top_combo DESC, fs.username ASC " +
        "LIMIT ?",
        [safeLimit]
    );

    return rows.map(function (row, index) {
        return {
            rank: index + 1,
            username: row.username,
            displayName: row.display_name || row.username,
            score: Number(row.top_score) || 0,
            maxCombo: Number(row.top_combo) || 0
        };
    });
}

async function bootstrap() {
    const SQL = await initSqlJs({
        locateFile: function (fileName) {
            return path.join(__dirname, 'node_modules', 'sql.js', 'dist', fileName);
        }
    });

    if (fs.existsSync(DB_FILE)) {
        db = new SQL.Database(fs.readFileSync(DB_FILE));
    } else {
        db = new SQL.Database();
    }

    createSchema();
    migrateLegacyProfiles();

    app.use(cors());
    app.use(bodyParser.json());
    app.use(express.static(__dirname));
    app.get('/', function (req, res) {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.get('/index.html', function (req, res) {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.get('/login.html', function (req, res) {
        res.sendFile(path.join(__dirname, 'login.html'));
    });

    app.get('/dashboard.html', function (req, res) {
        res.sendFile(path.join(__dirname, 'dashboard.html'));
    });

    app.get('/profile.html', function (req, res) {
        res.sendFile(path.join(__dirname, 'profile.html'));
    });

    app.get('/settings.html', function (req, res) {
        res.sendFile(path.join(__dirname, 'settings.html'));
    });

    app.get('/Social.html', function (req, res) {
        res.sendFile(path.join(__dirname, 'Social.html'));
    });

    app.post('/signup', async function (req, res) {
        const username = req.body.username;
        const password = req.body.password;

        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required.' });
        }

        if (ensureUserExists(username)) {
            return res.status(400).json({ message: 'username already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        runStatement(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            [username, hashedPassword]
        );
        seedDefaultRecords(username);

        res.status(201).json({ message: 'Sign-up successful!' });
    });

    app.post('/login', async function (req, res) {
        const username = req.body.username;
        const password = req.body.password;

        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required.' });
        }

        const user = getOne(
            'SELECT username, password_hash FROM users WHERE username = ?',
            [username]
        );

        if (!user) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        runStatement('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE username = ?', [username]);

        res.status(200).json({ message: 'Login successful!' });
    });

    app.get('/api/profile/:username', function (req, res) {
        const username = req.params.username;
        const resolvedUsername = resolveAccountIdentity(username) || username;
        const profile = getProfile(resolvedUsername);

        res.status(200).json({
            username: profile.username || resolvedUsername,
            displayName: profile.display_name,
            email: profile.email || '',
            region: profile.region || 'Asia / Mumbai',
            preferredRole: profile.preferred_role || 'Entry Fragger'
        });
    });

    app.put('/api/profile/:username', function (req, res) {
        const username = req.params.username;
        const payload = req.body;
        const nextUsername = payload.displayName ? payload.displayName.trim() : '';
        const resolvedUsername = resolveAccountIdentity(username);

        if (!payload.displayName || !payload.email || !payload.region || !payload.preferredRole) {
            return res.status(400).json({ message: 'All profile fields are required.' });
        }

        if (!resolvedUsername) {
            return res.status(404).json({ message: 'User not found.' });
        }

        try {
            saveProfile(resolvedUsername, {
                displayName: nextUsername,
                email: payload.email,
                region: payload.region,
                preferredRole: payload.preferredRole
            });
            const currentSettings = getUserSettings(resolvedUsername);
            saveUserSettings(resolvedUsername, {
                showOnlineStatus: currentSettings.show_online_status,
                matchInvites: currentSettings.match_invites,
                rankNotifications: currentSettings.rank_notifications,
                streamerMode: currentSettings.streamer_mode,
                twoFactorEnabled: currentSettings.two_factor_enabled,
                promotionalEmails: currentSettings.promotional_emails
            });

            renameUserIdentity(resolvedUsername, nextUsername);
        } catch (error) {
            console.error('Failed to save profile:', error);
            return res.status(500).json({ message: 'Database error' });
        }

        res.status(200).json({ message: 'Profile saved successfully!', username: nextUsername });
    });

    app.get('/api/user-settings/:username', function (req, res) {
        const username = req.params.username;
        const settings = getUserSettings(username);

        res.status(200).json({
            username: username,
            showOnlineStatus: !!settings.show_online_status,
            matchInvites: !!settings.match_invites,
            rankNotifications: !!settings.rank_notifications,
            streamerMode: !!settings.streamer_mode,
            twoFactorEnabled: !!settings.two_factor_enabled,
            promotionalEmails: !!settings.promotional_emails
        });
    });

    app.put('/api/user-settings/:username', function (req, res) {
        const username = req.params.username;
        const payload = req.body;
        const resolvedUsername = resolveAccountIdentity(username);

        if (!resolvedUsername) {
            return res.status(404).json({ message: 'User not found.' });
        }

        saveUserSettings(resolvedUsername, {
            showOnlineStatus: payload.showOnlineStatus ? 1 : 0,
            matchInvites: payload.matchInvites ? 1 : 0,
            rankNotifications: payload.rankNotifications ? 1 : 0,
            streamerMode: payload.streamerMode ? 1 : 0,
            twoFactorEnabled: payload.twoFactorEnabled ? 1 : 0,
            promotionalEmails: payload.promotionalEmails ? 1 : 0
        });

        res.status(200).json({ message: 'Settings saved successfully!' });
    });

    app.get('/api/frenzy-leaderboard', function (req, res) {
        const limit = parseInt(req.query.limit, 10);
        const leaderboard = getFrenzyLeaderboard(limit);
        res.status(200).json({ leaderboard: leaderboard });
    });

    app.post('/api/frenzy-score', function (req, res) {
        const payload = req.body || {};
        const username = typeof payload.username === 'string' ? payload.username.trim() : '';
        const score = Number(payload.score);
        const maxCombo = Number(payload.maxCombo);
        const bonuses = Number(payload.bonuses);

        if (!username) {
            return res.status(400).json({ message: 'Username is required.' });
        }

        if (!Number.isFinite(score) || score <= 0 || !Number.isFinite(maxCombo) || maxCombo < 0 || !Number.isFinite(bonuses) || bonuses < 0) {
            return res.status(400).json({ message: 'Invalid score payload.' });
        }

        const resolvedUsername = resolveAccountIdentity(username);
        if (!resolvedUsername || !ensureUserExists(resolvedUsername)) {
            return res.status(403).json({ message: 'Only registered users can submit scores.' });
        }

        runStatement(
            'INSERT INTO frenzy_scores (username, score, max_combo, bonuses, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [resolvedUsername, Math.round(score), Math.round(maxCombo), Math.round(bonuses)]
        );

        const leaderboard = getFrenzyLeaderboard(10);
        const playerHighScore = getOne(
            'SELECT MAX(score) AS high_score FROM frenzy_scores WHERE username = ?',
            [resolvedUsername]
        );

        res.status(201).json({
            message: 'Score submitted successfully!',
            username: resolvedUsername,
            leaderboard: leaderboard,
            highScore: Number(playerHighScore && playerHighScore.high_score) || 0
        });
    });

    app.listen(PORT, function () {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`SQLite database available at ${DB_FILE}`);
    });
}

bootstrap().catch(function (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
});
