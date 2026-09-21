"""
database/protection_db.py
──────────────────────────
SQLAlchemy model + CRUD helpers for position-level SL / Target / Trail protection.

OpenAlgo DB convention (matches auth_db.py, settings_db.py, etc.):
  • Uses raw SQLAlchemy with scoped_session — NOT Flask-SQLAlchemy (extensions.db)
  • db_session is registered in app.py teardown so connections are released per-request
  • init_db() / ensure_protection_tables_exists() creates the table on first run
"""

import os
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Float, Index,
    Integer, String, UniqueConstraint, create_engine,
)
from sqlalchemy.orm import DeclarativeBase, scoped_session, sessionmaker


# ─────────────────────────────────────────────────────────────────────────────
# DB connection  —  same pattern as every other OpenAlgo database module
# ─────────────────────────────────────────────────────────────────────────────

DATABASE_URL = os.getenv('DATABASE_URL', 'sqlite:///db/openalgo.db')

engine     = create_engine(DATABASE_URL, connect_args={'check_same_thread': False})
db_session = scoped_session(sessionmaker(autocommit=False, autoflush=False, bind=engine))


class Base(DeclarativeBase):
    pass


# ─────────────────────────────────────────────────────────────────────────────
# Model
# ─────────────────────────────────────────────────────────────────────────────

class PositionProtection(Base):
    """
    One row per (user, position).
    Position identity key = "{symbol}_{exchange}_{product}"
    e.g.  "NIFTY24DEC25000CE_NFO_NRML"
    """
    __tablename__ = 'position_protections'

    id           = Column(Integer, primary_key=True)
    user_id      = Column(Integer, nullable=False, index=True)

    # Position identity
    position_key = Column(String(200), nullable=False)
    symbol       = Column(String(100), nullable=False)
    exchange     = Column(String(20),  nullable=False)
    product      = Column(String(10),  nullable=False)

    # ── User-set values ──────────────────────────────────────────────────────
    sl_price        = Column(Float, nullable=True)
    target_price    = Column(Float, nullable=True)
    trailing_points = Column(Float, nullable=True)

    # ── Engine-maintained running state ─────────────────────────────────────
    best_price           = Column(Float,   nullable=True)
    current_sl           = Column(Float,   nullable=True)
    break_even_activated = Column(Boolean, default=False)

    # ── Lifecycle status ─────────────────────────────────────────────────────
    # ACTIVE    → engine is monitoring
    # TRIGGERED → close order fired, waiting for broker confirmation
    # CLOSED    → position confirmed closed, row kept for audit
    status = Column(String(20), default='ACTIVE', nullable=False, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint('user_id', 'position_key', name='uq_user_position_key'),
        Index('ix_protection_user_status', 'user_id', 'status'),
    )

    def to_dict(self) -> dict:
        """Serialize to the exact shape the frontend PositionProtection interface expects."""
        d: dict = {'status': self.status}
        if self.sl_price        is not None: d['sl_price']             = self.sl_price
        if self.target_price    is not None: d['target_price']         = self.target_price
        if self.trailing_points is not None: d['trailing_points']      = self.trailing_points
        if self.best_price      is not None: d['best_price']           = self.best_price
        if self.current_sl      is not None: d['current_sl']           = self.current_sl
        if self.break_even_activated is True: d['break_even_activated'] = True
        return d

    def __repr__(self):
        return f'<PositionProtection {self.position_key} user={self.user_id} status={self.status}>'


# ─────────────────────────────────────────────────────────────────────────────
# Table init  —  called from app.py setup_environment()
# ─────────────────────────────────────────────────────────────────────────────

def ensure_protection_tables_exists():
    """Create the position_protections table if it does not already exist."""
    Base.metadata.create_all(bind=engine)


# Legacy alias so add_position_protections.py migration still works
init_db = ensure_protection_tables_exists


# ─────────────────────────────────────────────────────────────────────────────
# CRUD helpers
# ─────────────────────────────────────────────────────────────────────────────

def upsert_protection(user_id: int, key: str, data: dict) -> PositionProtection:
    """
    Create or update a protection record.
    `data` mirrors the TypeScript PositionProtection interface.
    """
    rec = db_session.query(PositionProtection).filter_by(
        user_id=user_id, position_key=key
    ).first()

    if rec is None:
        parts    = key.split('_')
        product  = parts[-1]         if len(parts) >= 3 else 'NRML'
        exchange = parts[-2]         if len(parts) >= 3 else 'NFO'
        symbol   = '_'.join(parts[:-2]) if len(parts) >= 3 else key

        rec = PositionProtection(
            user_id=user_id,
            position_key=key,
            symbol=symbol,
            exchange=exchange,
            product=product,
        )
        db_session.add(rec)

    scalar_fields = (
        'sl_price', 'target_price', 'trailing_points',
        'best_price', 'current_sl', 'break_even_activated', 'status',
    )
    for field in scalar_fields:
        if field in data:
            setattr(rec, field, data[field])

    setattr(rec, 'updated_at', datetime.utcnow())
    db_session.commit()
    return rec


def get_protections_for_user(user_id: int) -> dict:
    """Return all ACTIVE/TRIGGERED protections for a user as { position_key: {...} }."""
    rows = db_session.query(PositionProtection).filter(
        PositionProtection.user_id == user_id,
        PositionProtection.status.in_(['ACTIVE', 'TRIGGERED']),
    ).all()
    return {r.position_key: r.to_dict() for r in rows}


def get_all_active_protections() -> list:
    """Return every ACTIVE PositionProtection row across all users (used by engine)."""
    return db_session.query(PositionProtection).filter_by(status='ACTIVE').all()


def delete_protection(user_id: int, key: str) -> bool:
    """Hard-delete a protection record."""
    rec = db_session.query(PositionProtection).filter_by(
        user_id=user_id, position_key=key
    ).first()
    if rec:
        db_session.delete(rec)
        db_session.commit()
        return True
    return False


def get_user_api_key(user_id: int) -> str | None:
    """Get the active API key using OpenAlgo's own helper."""
    try:
        from database.auth_db import get_first_available_api_key
        return get_first_available_api_key()
    except Exception:
        return None