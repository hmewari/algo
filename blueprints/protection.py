"""
blueprints/protection.py
──────────────────────────
Persists position protection settings (SL / Target / Trail) in the DB.
All SL/BE/Trail calculations run client-side in Positions.tsx on every
live price tick — this blueprint is storage only.

Endpoints:
    GET  /api/protection/load           — load all protections for user
    POST /api/protection/save           — upsert one protection
    POST /api/protection/delete         — remove one protection
    GET  /api/protection/settings       — brokerage settings (for BE calc)
    POST /api/protection/settings       — save brokerage settings
    GET  /api/protection/analyze-mode   — sandbox vs live mode flag
"""

from flask import Blueprint, jsonify, request, session, abort
from database.protection_db import (
    delete_protection,
    get_protections_for_user,
    upsert_protection,
)

protection_bp = Blueprint('protection', __name__)


def get_user_id() -> int:
    """
    Resolve the authenticated user's integer id.
    OpenAlgo stores session['logged_in'] and session['user'] (username).
    """
    if not session.get('logged_in'):
        abort(401, description="Unauthorized")
    username = session.get('user')
    if not username:
        abort(401, description="No username in session")
    try:
        auth_module = __import__('database.auth_db', fromlist=['User', 'db_session'])
        User = getattr(auth_module, 'User', None)
        auth_session = getattr(auth_module, 'db_session', None)
        if auth_session is not None and User is not None:
            user = auth_session.query(User).filter_by(username=username).first()
            if user:
                return user.id
    except Exception:
        pass
    return 1  # single-user fallback


# ── Brokerage settings helpers ────────────────────────────────────────────────

def _get_engine():
    from database.protection_db import engine
    return engine


def _parse_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes', 'on')
    return default


def _parse_float(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _ensure_settings_table():
    from sqlalchemy import text
    with _get_engine().connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS protection_settings (
                id                             INTEGER PRIMARY KEY,
                protection_flat_brokerage      REAL    DEFAULT 20.0,
                protection_tax_percent         REAL    DEFAULT 0.0025,
                positions_portfolio_sl_enabled INTEGER DEFAULT 0,
                positions_trail_equity_enabled INTEGER DEFAULT 0,
                positions_portfolio_sl_percent REAL    DEFAULT 10.0,
                positions_scalper_default_sl   REAL    DEFAULT 2.0,
                positions_scalper_default_trail REAL   DEFAULT 2.0
            )
        """))

        existing_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(protection_settings)")).fetchall()
        }
        migrations = [
            ("positions_portfolio_sl_enabled", "INTEGER DEFAULT 0"),
            ("positions_trail_equity_enabled", "INTEGER DEFAULT 0"),
            ("positions_portfolio_sl_percent", "REAL DEFAULT 10.0"),
            ("positions_scalper_default_sl", "REAL DEFAULT 2.0"),
            ("positions_scalper_default_trail", "REAL DEFAULT 2.0"),
        ]
        for name, definition in migrations:
            if name not in existing_columns:
                conn.execute(text(f"ALTER TABLE protection_settings ADD COLUMN {name} {definition}"))

        conn.execute(text(
            "INSERT OR IGNORE INTO protection_settings "
            "(id, protection_flat_brokerage, protection_tax_percent, "
            "positions_portfolio_sl_enabled, positions_trail_equity_enabled, "
            "positions_portfolio_sl_percent, positions_scalper_default_sl, positions_scalper_default_trail) "
            "VALUES (1, 20.0, 0.0025, 0, 0, 10.0, 2.0, 2.0)"
        ))
        conn.commit()


def get_brokerage_from_db():
    from sqlalchemy import text
    default = {
        'flat_brokerage': 20.0,
        'tax_percent': 0.0025,
        'portfolio_sl_enabled': False,
        'trail_equity_enabled': False,
        'portfolio_sl_percent': 10.0,
        'scalper_default_sl': 2.0,
        'scalper_default_trail': 2.0,
    }
    try:
        _ensure_settings_table()
        with _get_engine().connect() as conn:
            row = conn.execute(text(
                "SELECT protection_flat_brokerage, protection_tax_percent, "
                "positions_portfolio_sl_enabled, positions_trail_equity_enabled, "
                "positions_portfolio_sl_percent, positions_scalper_default_sl, positions_scalper_default_trail "
                "FROM protection_settings WHERE id = 1"
            )).fetchone()
            if row:
                return {
                    'flat_brokerage': float(row[0]),
                    'tax_percent': float(row[1]),
                    'portfolio_sl_enabled': bool(row[2]),
                    'trail_equity_enabled': bool(row[3]),
                    'portfolio_sl_percent': float(row[4]),
                    'scalper_default_sl': float(row[5]),
                    'scalper_default_trail': float(row[6]),
                }
    except Exception as e:
        print(f"Error reading brokerage: {e}")
    return default


def save_brokerage_to_db(
    flat_brokerage,
    tax_percent,
    portfolio_sl_enabled,
    trail_equity_enabled,
    portfolio_sl_percent,
    scalper_default_sl,
    scalper_default_trail,
):
    from sqlalchemy import text
    try:
        _ensure_settings_table()
        with _get_engine().connect() as conn:
            conn.execute(text(
                "INSERT INTO protection_settings "
                "(id, protection_flat_brokerage, protection_tax_percent, "
                "positions_portfolio_sl_enabled, positions_trail_equity_enabled, "
                "positions_portfolio_sl_percent, positions_scalper_default_sl, positions_scalper_default_trail) "
                "VALUES (1, :flat, :tax, :portfolio_sl_enabled, :trail_equity_enabled, :portfolio_sl_percent, :scalper_default_sl, :scalper_default_trail) "
                "ON CONFLICT(id) DO UPDATE SET "
                "protection_flat_brokerage = excluded.protection_flat_brokerage, "
                "protection_tax_percent    = excluded.protection_tax_percent, "
                "positions_portfolio_sl_enabled = excluded.positions_portfolio_sl_enabled, "
                "positions_trail_equity_enabled = excluded.positions_trail_equity_enabled, "
                "positions_portfolio_sl_percent = excluded.positions_portfolio_sl_percent, "
                "positions_scalper_default_sl = excluded.positions_scalper_default_sl, "
                "positions_scalper_default_trail = excluded.positions_scalper_default_trail"
            ), {
                'flat': float(flat_brokerage),
                'tax': float(tax_percent),
                'portfolio_sl_enabled': int(bool(portfolio_sl_enabled)),
                'trail_equity_enabled': int(bool(trail_equity_enabled)),
                'portfolio_sl_percent': float(portfolio_sl_percent),
                'scalper_default_sl': float(scalper_default_sl),
                'scalper_default_trail': float(scalper_default_trail),
            })
            conn.commit()
        return True
    except Exception as e:
        print(f"Error saving brokerage: {e}")
        return False


# ── Core CRUD endpoints ───────────────────────────────────────────────────────

@protection_bp.route('/api/protection/load', methods=['GET'])
def load_protections():
    try:
        protections = get_protections_for_user(get_user_id())
        return jsonify({'status': 'success', 'protections': protections})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@protection_bp.route('/api/protection/save', methods=['POST'])
def save_protection():
    data = request.get_json(silent=True) or {}
    key  = (data.get('key') or '').strip()
    protection = data.get('protection') or {}
    if not key:
        return jsonify({'status': 'error', 'message': 'key is required'}), 400
    try:
        upsert_protection(get_user_id(), key, protection)
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@protection_bp.route('/api/protection/delete', methods=['POST'])
def delete_protection_route():
    data = request.get_json(silent=True) or {}
    key  = (data.get('key') or '').strip()
    if not key:
        return jsonify({'status': 'error', 'message': 'key is required'}), 400
    try:
        deleted = delete_protection(get_user_id(), key)
        return jsonify({'status': 'success', 'deleted': deleted})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── Settings endpoints ────────────────────────────────────────────────────────

@protection_bp.route('/api/protection/settings', methods=['GET'])
def get_protection_settings():
    try:
        settings = get_brokerage_from_db()
        return jsonify({'status': 'success', 'settings': settings})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@protection_bp.route('/api/protection/settings', methods=['POST'])
def save_protection_settings():
    data = request.get_json(silent=True) or {}
    flat = data.get('flat_brokerage')
    tax  = data.get('tax_percent')
    portfolio_sl_enabled    = data.get('portfolio_sl_enabled')
    trail_equity_enabled    = data.get('trail_equity_enabled')
    portfolio_sl_percent    = data.get('portfolio_sl_percent')
    scalper_default_sl      = data.get('scalper_default_sl')
    scalper_default_trail   = data.get('scalper_default_trail')

    try:
        current = get_brokerage_from_db()

        flat_val   = _parse_float(flat, current['flat_brokerage'])
        tax_val    = _parse_float(tax, current['tax_percent'])
        portfolio_sl_enabled_val = _parse_bool(portfolio_sl_enabled, current['portfolio_sl_enabled'])
        trail_equity_enabled_val = _parse_bool(trail_equity_enabled, current['trail_equity_enabled'])
        portfolio_sl_percent_val = _parse_float(portfolio_sl_percent, current['portfolio_sl_percent'])
        scalper_default_sl_val   = _parse_float(scalper_default_sl, current['scalper_default_sl'])
        scalper_default_trail_val= _parse_float(scalper_default_trail, current['scalper_default_trail'])

        save_brokerage_to_db(
            flat_val,
            tax_val,
            portfolio_sl_enabled_val,
            trail_equity_enabled_val,
            portfolio_sl_percent_val,
            scalper_default_sl_val,
            scalper_default_trail_val,
        )
        settings = get_brokerage_from_db()
        return jsonify({'status': 'success', 'settings': settings})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@protection_bp.route('/api/protection/analyze-mode', methods=['GET'])
def get_analyze_mode():
    try:
        from database.settings_db import get_analyze_mode
        return jsonify({'status': 'success', 'analyze_mode': get_analyze_mode()})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500
