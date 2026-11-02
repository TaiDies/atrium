import type { Proposal } from '../ai/build';

// Ready-made templates, built the same way as the AI assistant's proposals (see ai/build.ts).

export interface BuiltinTemplate {
  id: string;
  name: string;
  icon: string;
  category: 'Personal' | 'Work' | 'School';
  description: string;
  proposal: Proposal;
}

const doc = (title: string, icon: string, markdown: string): Proposal => ({
  documents: [{ ref: 'page', title, icon, parent: null, appendTo: null, markdown }],
  databases: [],
  tasks: [],
});

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    icon: '🗒️',
    category: 'Work',
    description: 'Agenda, notes, decisions and action items.',
    proposal: doc(
      'Meeting notes',
      '🗒️',
      `**Date:** \n**Attendees:** \n\n## Agenda\n1. \n2. \n3. \n\n## Notes\n- \n\n## Decisions\n- \n\n## Action items\n- [ ] \n- [ ] \n`,
    ),
  },
  {
    id: 'weekly-plan',
    name: 'Weekly plan',
    icon: '📅',
    category: 'Personal',
    description: 'Goals for the week, a day-by-day plan and a review.',
    proposal: doc(
      'Weekly plan',
      '📅',
      `## This week's goals\n- [ ] \n- [ ] \n- [ ] \n\n## Monday\n- [ ] \n\n## Tuesday\n- [ ] \n\n## Wednesday\n- [ ] \n\n## Thursday\n- [ ] \n\n## Friday\n- [ ] \n\n## Weekend\n- [ ] \n\n## Review\n**What went well:** \n\n**What to change next week:** \n`,
    ),
  },
  {
    id: 'daily-journal',
    name: 'Daily journal',
    icon: '📓',
    category: 'Personal',
    description: 'A short daily check-in: priorities, gratitude and reflection.',
    proposal: doc(
      'Journal',
      '📓',
      `## Top 3 today\n- [ ] \n- [ ] \n- [ ] \n\n## I'm grateful for\n- \n\n## Notes\n\n\n## How did today go?\n`,
    ),
  },
  {
    id: 'class-notes',
    name: 'Class notes',
    icon: '🎓',
    category: 'School',
    description: 'Key ideas, notes, questions and a summary (Cornell style).',
    proposal: doc(
      'Class notes',
      '🎓',
      `**Course:** \n**Topic:** \n**Date:** \n\n## Key ideas\n- \n\n## Notes\n\n\n## Questions\n- \n\n## Summary\n> Sum up the lesson in two or three sentences.\n`,
    ),
  },
  {
    id: 'project-tracker',
    name: 'Project tracker',
    icon: '🚀',
    category: 'Work',
    description: 'A board of tasks with status, priority and due dates.',
    proposal: {
      documents: [],
      tasks: [],
      databases: [
        {
          ref: 'db',
          title: 'Project tracker',
          icon: '🚀',
          parent: null,
          layout: 'board',
          fields: [
            { name: 'Status', type: 'select', options: ['To Do', 'Doing', 'Done'] },
            { name: 'Priority', type: 'select', options: ['High', 'Medium', 'Low'] },
            { name: 'Due', type: 'date', options: [] },
          ],
          rows: [
            { name: 'Write the project brief', cells: { Status: 'Doing', Priority: 'High' }, notes: '## Goal\n\n## Scope\n\n## Risks\n' },
            { name: 'Plan the milestones', cells: { Status: 'To Do', Priority: 'Medium' }, notes: '' },
            { name: 'Kick-off meeting', cells: { Status: 'To Do', Priority: 'Low' }, notes: '' },
          ],
        },
      ],
    },
  },
  {
    id: 'reading-list',
    name: 'Reading list',
    icon: '📚',
    category: 'Personal',
    description: 'Books and articles to read, with status and rating.',
    proposal: {
      documents: [],
      tasks: [],
      databases: [
        {
          ref: 'db',
          title: 'Reading list',
          icon: '📚',
          parent: null,
          layout: 'gallery',
          fields: [
            { name: 'Author', type: 'text', options: [] },
            { name: 'Status', type: 'select', options: ['Want to read', 'Reading', 'Finished'] },
            { name: 'Type', type: 'select', options: ['Book', 'Article', 'Paper'] },
            { name: 'Rating', type: 'number', options: [] },
            { name: 'Link', type: 'url', options: [] },
          ],
          rows: [{ name: 'My next book', cells: { Status: 'Want to read', Type: 'Book' }, notes: '## Why I want to read it\n\n## Notes\n' }],
        },
      ],
    },
  },
  {
    id: 'assignments',
    name: 'Assignment tracker',
    icon: '📝',
    category: 'School',
    description: 'Homework and exams by course, with due dates.',
    proposal: {
      documents: [],
      tasks: [],
      databases: [
        {
          ref: 'db',
          title: 'Assignments',
          icon: '📝',
          parent: null,
          layout: 'grid',
          fields: [
            { name: 'Course', type: 'select', options: [] },
            { name: 'Type', type: 'select', options: ['Homework', 'Essay', 'Exam', 'Project'] },
            { name: 'Due', type: 'date', options: [] },
            { name: 'Done', type: 'checkbox', options: [] },
          ],
          rows: [],
        },
      ],
    },
  },
  {
    id: 'habit-tracker',
    name: 'Habit tracker',
    icon: '✅',
    category: 'Personal',
    description: 'One row per day, a tick for each habit.',
    proposal: {
      documents: [],
      tasks: [],
      databases: [
        {
          ref: 'db',
          title: 'Habits',
          icon: '✅',
          parent: null,
          layout: 'grid',
          fields: [
            { name: 'Date', type: 'date', options: [] },
            { name: 'Exercise', type: 'checkbox', options: [] },
            { name: 'Read', type: 'checkbox', options: [] },
            { name: 'Water', type: 'checkbox', options: [] },
            { name: 'Sleep 8h', type: 'checkbox', options: [] },
          ],
          rows: [],
        },
      ],
    },
  },
  {
    id: 'content-calendar',
    name: 'Content calendar',
    icon: '🗓️',
    category: 'Work',
    description: 'Posts and articles on a calendar, with channel and status.',
    proposal: {
      documents: [],
      tasks: [],
      databases: [
        {
          ref: 'db',
          title: 'Content calendar',
          icon: '🗓️',
          parent: null,
          layout: 'calendar',
          fields: [
            { name: 'Publish on', type: 'date', options: [] },
            { name: 'Channel', type: 'select', options: ['Blog', 'Newsletter', 'Social'] },
            { name: 'Status', type: 'select', options: ['Idea', 'Writing', 'Scheduled', 'Published'] },
          ],
          rows: [],
        },
      ],
    },
  },
  {
    id: 'roadmap',
    name: 'Roadmap',
    icon: '🛣️',
    category: 'Work',
    description: 'Features on a timeline from start to finish.',
    proposal: {
      documents: [],
      tasks: [],
      databases: [
        {
          ref: 'db',
          title: 'Roadmap',
          icon: '🛣️',
          parent: null,
          layout: 'timeline',
          fields: [
            { name: 'Start', type: 'date', options: [] },
            { name: 'End', type: 'date', options: [] },
            { name: 'Status', type: 'select', options: ['Planned', 'Building', 'Shipped'] },
          ],
          rows: [],
        },
      ],
    },
  },
];
