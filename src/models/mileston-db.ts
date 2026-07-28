// in the same file or another route file
import { QueryResult } from 'pg';

// src/routes/milestoneQueries.ts
import { Router, Request, Response } from 'express';
import { Client, ClientConfig } from 'pg';
const router = Router();

// however you define this in your project:
const dbconfig = {
    host: '',
    user: 'blust',
    password: 'test!!',
    database: 'test',
    port: 5432,
    ssl: true
}

// src/types/milestones.ts

export interface Scope {
  minPxPerMonth?: number | null;
  maxPxPerMonth?: number | null;
  minPxPerDay?: number | null;
  maxPxPerDay?: number | null;
  minPxPerHour?: number | null;
  maxPxPerHour?: number | null;
}

export interface Milestone {
  x: number;
  y: number;
  type: 'milestone' | string;
  name: string;
  color?: string;
  date: string;        // ISO string coming from client
  url?: string | null;
  scope?: Scope;
}

export interface WindowRange {
  start: string;       // ISO string
  end: string;         // ISO string
}

export interface SaveMilestoneQueryBody {
  queryString: string;
  date?: string;       // optional, default to now if missing
  window: WindowRange;
  milestones: Milestone[];
}


router.post('/save-milestone-query', async (req: SaveMilestoneQueryRequest, res: Response) => {
  try {
    const body = req.body;
    const { queryString, date, window, milestones } = body;

    if (!queryString || !window || !window.start || !window.end || !Array.isArray(milestones)) {
      return res.status(400).json({
        status: 'error',
        msg: 'Must provide queryString, window.start, window.end, and milestones[]'
      });
    }

    // default date to now if not supplied
    const queryDate = date || new Date().toISOString();

    // ensure milestones is valid JSON-serializable
    const milestonesJson = JSON.stringify(milestones as Milestone[]);

    const client = new Client(dbconfig);
    await client.connect();

    try {
      const insertSql = `
        INSERT INTO exp.milestone_queries
          (query_string, query_date, window_start, window_end, milestones)
        VALUES
          ($1, $2, $3, $4, $5)
        RETURNING id, query_date
      `;

      const values = [
        queryString,
        queryDate,
        window.start,
        window.end,
        milestonesJson
      ];

      const dbRes = await client.query(insertSql, values);

      if (dbRes.rowCount && dbRes.rowCount > 0) {
        const row = dbRes.rows[0];
        return res.json({
          status: 'success',
          msg: 'Milestone query saved',
          id: row.id,
          query_date: row.query_date
        });
      } else {
        return res.status(500).json({
          status: 'error',
          msg: 'Insert returned no rows'
        });
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    console.error('Error in /save-milestone-query:', err);
    return res.status(500).json({
      status: 'error',
      msg: 'Internal server error'
    });
  }
});



interface MilestoneQueryRow {
  id: number;
  query_string: string;
  query_date: string;
  window_start: string;
  window_end: string;
  milestones: any;   // you can refine this to Milestone[] if you want
}

/* ------------------------------------------------------
 *  SCHEMA CREATION (Option A: explicit init route)
 * ----------------------------------------------------*/

// Idempotent: safe to run multiple times
const CREATE_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS exp;

CREATE TABLE IF NOT EXISTS exp.milestone_queries (
    id BIGSERIAL PRIMARY KEY,

    query_string TEXT NOT NULL,
    query_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    window_start TIMESTAMPTZ NOT NULL,
    window_end   TIMESTAMPTZ NOT NULL,

    milestones   JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_milestone_queries_date
  ON exp.milestone_queries (query_date DESC);

CREATE INDEX IF NOT EXISTS idx_milestone_queries_query_string
  ON exp.milestone_queries USING gin (to_tsvector('english', query_string));
`;

// GET /ms/init-milestone-schema
router.get('/init-milestone-schema', async (_req: Request, res: Response) => {
  const client = new Client(dbconfig);

  try {
    await client.connect();
    await client.query(CREATE_SCHEMA_SQL);

    return res.json({
      status: 'success',
      msg: 'Milestone schema initialized'
    });
  } catch (err) {
    console.error('Schema init error:', err);
    return res.status(500).json({
      status: 'error',
      msg: 'Failed to initialize schema'
    });
  } finally {
    await client.end();
  }
});

export interface Scope {
  minPxPerMonth?: number | null;
  maxPxPerMonth?: number | null;
  minPxPerDay?: number | null;
  maxPxPerDay?: number | null;
  minPxPerHour?: number | null;
  maxPxPerHour?: number | null;
}

export interface Milestone {
  x: number;
  y: number;
  type: 'milestone' | string;
  name: string;
  color?: string;
  date: string;        // ISO string coming from client
  url?: string | null;
  scope?: Scope;
}

export interface WindowRange {
  start: string;       // ISO string
  end: string;         // ISO string
}

export interface SaveMilestoneQueryBody {
  queryString: string;
  date?: string;       // optional, default to now if missing
  window: WindowRange;
  milestones: Milestone[];
}

type SaveMilestoneQueryRequest = Request<{}, any, SaveMilestoneQueryBody>;

/* ------------------------------------------------------
 *  POST /save-milestone-query
 * ----------------------------------------------------*/

router.post('/save-milestone-query', async (req: SaveMilestoneQueryRequest, res: Response) => {
  try {
    const body = req.body;
    const { queryString, date, window, milestones } = body;

    if (!queryString || !window || !window.start || !window.end || !Array.isArray(milestones)) {
      return res.status(400).json({
        status: 'error',
        msg: 'Must provide queryString, window.start, window.end, and milestones[]'
      });
    }

    // default date to now if not supplied
    const queryDate = date || new Date().toISOString();

    // ensure milestones is valid JSON-serializable
    const milestonesJson = JSON.stringify(milestones as Milestone[]);

    const client = new Client(dbconfig);
    await client.connect();

    try {
      const insertSql = `
        INSERT INTO exp.milestone_queries
          (query_string, query_date, window_start, window_end, milestones)
        VALUES
          ($1, $2, $3, $4, $5)
        RETURNING id, query_date
      `;

      const values = [
        queryString,
        queryDate,
        window.start,
        window.end,
        milestonesJson
      ];

      const dbRes = await client.query(insertSql, values);

      if (dbRes.rowCount && dbRes.rowCount > 0) {
        const row = dbRes.rows[0];
        return res.json({
          status: 'success',
          msg: 'Milestone query saved',
          id: row.id,
          query_date: row.query_date
        });
      } else {
        return res.status(500).json({
          status: 'error',
          msg: 'Insert returned no rows'
        });
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    console.error('Error in /save-milestone-query:', err);
    return res.status(500).json({
      status: 'error',
      msg: 'Internal server error'
    });
  }
});

/* ------------------------------------------------------
 *  GET /list-milestone-queries
 * ----------------------------------------------------*/

interface MilestoneQueryRow {
  id: number;
  query_string: string;
  query_date: string;
  window_start: string;
  window_end: string;
  milestones: any;   // you can refine this to Milestone[] if you want
}

router.get('/list-milestone-queries', async (req: Request, res: Response) => {
  const client = new Client(dbconfig);

  try {
    await client.connect();

    const queryString = `
      SELECT
        id,
        query_string,
        query_date,
        window_start,
        window_end,
        milestones
      FROM exp.milestone_queries
      ORDER BY id DESC
      LIMIT 1000
    `;

    const dbRes: QueryResult<MilestoneQueryRow> = await client.query(queryString);

    if (dbRes.rowCount && dbRes.rowCount > 0) {
      return res.json({
        status: 'success',
        msg: dbRes.rowCount,
        rows: dbRes.rows
      });
    } else {
      return res.json({
        status: 'None',
        msg: 'No milestone queries found',
        rows: []
      });
    }
  } catch (err) {
    console.error('Error in /list-milestone-queries:', err);
    return res.status(500).json({
      status: 'error',
      msg: 'Internal server error'
    });
  } finally {
    await client.end();
  }
});

export default router;



router.get('/list-milestone-queries', async (req: Request, res: Response) => {
  const client = new Client(dbconfig);

  try {
    await client.connect();

    const queryString = `
      SELECT
        id,
        query_string,
        query_date,
        window_start,
        window_end,
        milestones
      FROM exp.milestone_queries
      ORDER BY id DESC
      LIMIT 1000
    `;

    const dbRes: QueryResult<MilestoneQueryRow> = await client.query(queryString);

    if (dbRes.rowCount && dbRes.rowCount > 0) {
      return res.json({
        status: 'success',
        msg: dbRes.rowCount,
        rows: dbRes.rows
      });
    } else {
      return res.json({
        status: 'None',
        msg: 'No milestone queries found',
        rows: []
      });
    }
  } catch (err) {
    console.error('Error in /list-milestone-queries:', err);
    return res.status(500).json({
      status: 'error',
      msg: 'Internal server error'
    });
  } finally {
    await client.end();
  }
});
