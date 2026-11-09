import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareAchievements } from '../src/achievement-sorting.ts';
const a = {id:'a',name:'Alpha',gamerscore:10,unlockedAt:100,rarity:{percentage:1}};
const b = {id:'b',name:'Beta',gamerscore:20,unlockedAt:200,rarity:{percentage:20}};
test('every sort supports ascending and descending', () => {
  for (const sort of ['name','gamerscore','date','rarity']) {
    assert.deepEqual([b,a].sort((x,y)=>compareAchievements(x,y,sort,'asc')).map(x=>x.id), ['a','b']);
    assert.deepEqual([a,b].sort((x,y)=>compareAchievements(x,y,sort,'desc')).map(x=>x.id), ['b','a']);
  }
});
test('missing and invalid rarity stay last in either direction; zero is valid', () => {
  const zero = {...a,id:'zero',rarity:{percentage:0}};
  for (const direction of ['asc','desc']) {
    for (const rarity of [undefined,{percentage:NaN},{percentage:-1},{percentage:101}]) {
      const unknown = {...a,id:'unknown',rarity};
      assert.deepEqual([unknown,zero].sort((x,y)=>compareAchievements(x,y,'rarity',direction)).map(x=>x.id), ['zero','unknown']);
    }
    assert.ok(compareAchievements({...a,unlockedAt:null},b,'date',direction)>0);
  }
});
