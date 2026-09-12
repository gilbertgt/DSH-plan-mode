import type { ValidationCommand } from '../contract/plan-artifact.ts'
export function commandsForTasks(commands:ValidationCommand[],taskIds:string[]){const set=new Set(taskIds);return commands.filter(c=>c.taskIds.some(id=>set.has(id)))}
