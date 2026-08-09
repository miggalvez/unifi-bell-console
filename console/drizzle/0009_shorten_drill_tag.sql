-- The drill tag is spoken before AND after every sound, and again between each
-- repetition, so its length is paid many times over in a sounding phase.
-- "This is a drill." alone carries the whole meaning in half the words.
--
-- Guarded on the old wording so a school that has already reworded its own
-- announcement keeps what it wrote. Fresh installs pass through here too:
-- 0004 seeds the long form and this immediately shortens it, rather than
-- editing an already-applied migration.
UPDATE `sound_cues`
   SET `tts_text` = 'This is a drill.',
       `updated_at` = unixepoch() * 1000
 WHERE `name` = 'Drill preamble'
   AND `tts_text` = 'This is a drill. This is only a drill.';
