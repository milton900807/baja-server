// models/MilestoneQuery.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ---- Scope subdocument ----
const ScopeSchema = new Schema(
  {
    minPxPerMonth: { type: Number, default: null },
    maxPxPerMonth: { type: Number, default: null },
    minPxPerDay:   { type: Number, default: null },
    maxPxPerDay:   { type: Number, default: null },
    minPxPerHour:  { type: Number, default: null },
    maxPxPerHour:  { type: Number, default: null }
  },
  { _id: false }
);

// ---- Milestone subdocument ----
const MilestoneSchema = new Schema(
  {
    x:     { type: Number, required: true },
    y:     { type: Number, required: true },
    type:  { type: String, default: 'milestone' },
    name:  { type: String, required: true },
    color: { type: String },
    date:  { type: Date, required: true },
    url:   { type: String, default: null },
    scope: { type: ScopeSchema, default: {} }
  },
  { _id: false }
);

// ---- Window subdocument ----
const WindowSchema = new Schema(
  {
    start: { type: Date, required: true },
    end:   { type: Date, required: true }
  },
  { _id: false }
);

// ---- Parent query object ----
const MilestoneQuerySchema = new Schema(
  {
    queryString: { type: String, required: true }, // the query text
    date:        { type: Date, default: Date.now }, // when this query was executed/saved

    window:      { type: WindowSchema, required: true },
    milestones:  { type: [MilestoneSchema], default: [] }
  },
  {
    timestamps: true // createdAt / updatedAt
  }
);

module.exports = mongoose.model('MilestoneQuery', MilestoneQuerySchema);
