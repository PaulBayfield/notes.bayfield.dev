//! Spelling from the Windows spell checker, in all the user's writing languages.
//!
//! WebView2's own spell check only knows one language (the display one), so English gets
//! underlined on a French Windows, and its right-click menu items come without their text. So the
//! app asks Windows itself: the misspelled words to underline, suggestions for its own menu, "Add
//! to dictionary", and Windows' autocorrect list ("teh" becomes "the") for correcting as you type.
//! A word only counts as misspelled when it's wrong in every language.

use serde::Serialize;

#[derive(Serialize, Default)]
pub struct Spelling {
    /// Not a word in any of the languages checked.
    misspelled: bool,
    suggestions: Vec<String>,
    /// What Windows corrects it to as you type, when it's on its autocorrect list.
    autocorrect: Option<String>,
}

/// Lowercase, without accents ("Très" and "tres" are the same letters).
#[cfg_attr(not(windows), allow(dead_code))]
fn fold_accents(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => out.push('a'),
            'ç' => out.push('c'),
            'è' | 'é' | 'ê' | 'ë' => out.push('e'),
            'ì' | 'í' | 'î' | 'ï' => out.push('i'),
            'ñ' => out.push('n'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' => out.push('o'),
            'ù' | 'ú' | 'û' | 'ü' => out.push('u'),
            'ý' | 'ÿ' => out.push('y'),
            'œ' => out.push_str("oe"),
            'æ' => out.push_str("ae"),
            c => out.push(c),
        }
    }
    out
}

/// At most this many suggestions in the menu.
const MAX_SUGGESTIONS: usize = 6;

#[cfg(windows)]
mod imp {
    use super::{MAX_SUGGESTIONS, Spelling};
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use windows::Win32::Globalization::{
        CORRECTIVE_ACTION_GET_SUGGESTIONS, CORRECTIVE_ACTION_REPLACE, ISpellChecker, ISpellCheckerFactory, ISpellingError, SpellCheckerFactory,
    };
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree};
    use windows_core::{HSTRING, PWSTR};

    thread_local! {
        /// Spell checkers by language; `None` for a language Windows can't check.
        static CHECKERS: RefCell<HashMap<String, Option<ISpellChecker>>> = RefCell::new(HashMap::new());
    }

    fn create(lang: &str) -> Option<ISpellChecker> {
        unsafe {
            // Once per thread (the checkers are kept per thread too).
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: ISpellCheckerFactory = CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let tag = HSTRING::from(lang);
            if !factory.IsSupported(&tag).ok()?.as_bool() {
                return None;
            }
            factory.CreateSpellChecker(&tag).ok()
        }
    }

    /// The user's Windows languages (Settings > Language), in order.
    pub fn windows_languages() -> Vec<String> {
        windows_registry::CURRENT_USER
            .open(r"Control Panel\International\User Profile")
            .and_then(|k| k.get_multi_string("Languages"))
            .unwrap_or_default()
            .into_iter()
            .filter(|l| !l.is_empty())
            .collect()
    }

    /// The Windows languages first, then the page's.
    fn with_windows_languages(languages: &[String]) -> Vec<String> {
        windows_languages().into_iter().chain(languages.iter().cloned()).collect()
    }

    /// The checkers for the languages Windows can check, in the order given, one per language
    /// ("fr-FR" and "fr" would only repeat each other's suggestions).
    fn checkers(languages: &[String]) -> Vec<ISpellChecker> {
        let mut seen = Vec::new();
        CHECKERS.with_borrow_mut(|cache| {
            with_windows_languages(languages)
                .iter()
                .filter_map(|lang| {
                    let checker = cache.entry(lang.clone()).or_insert_with(|| create(lang)).clone()?;
                    let primary = lang.split('-').next().unwrap_or(lang).to_lowercase();
                    if seen.contains(&primary) {
                        return None;
                    }
                    seen.push(primary);
                    Some(checker)
                })
                .collect()
        })
    }

    /// Takes a string Windows allocated.
    unsafe fn take(p: PWSTR) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let s = unsafe { p.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(p.0 as _)) };
        s.filter(|s| !s.is_empty())
    }

    /// One language's take on the word: `None` when it's a word there.
    unsafe fn check_in(checker: &ISpellChecker, word: &HSTRING) -> Option<(Vec<String>, Option<String>)> {
        let errors = unsafe { checker.Check(word) }.ok()?;
        let mut error: Option<ISpellingError> = None;
        if unsafe { errors.Next(&mut error) }.is_err() {
            return None;
        }
        let error = error?;
        let mut suggestions = Vec::new();
        let mut fix = None;
        match unsafe { error.CorrectiveAction() } {
            Ok(CORRECTIVE_ACTION_REPLACE) => {
                fix = unsafe { error.Replacement() }.ok().and_then(|p| unsafe { take(p) });
                suggestions.extend(fix.clone());
            }
            Ok(CORRECTIVE_ACTION_GET_SUGGESTIONS) => {
                if let Ok(list) = unsafe { checker.Suggest(word) } {
                    loop {
                        let mut item = [PWSTR::null()];
                        let mut fetched = 0u32;
                        if unsafe { list.Next(&mut item, Some(&mut fetched)) }.is_err() || fetched == 0 {
                            break;
                        }
                        suggestions.extend(unsafe { take(item[0]) });
                    }
                }
            }
            _ => {}
        }
        Some((suggestions, fix))
    }

    pub fn check(word: &str, languages: &[String]) -> Spelling {
        let typed = word;
        let word = HSTRING::from(word);
        let mut lists = Vec::new();
        let mut out = Spelling::default();
        for checker in checkers(languages) {
            // A word in any of the languages is fine as it is.
            let Some((suggestions, fix)) = (unsafe { check_in(&checker, &word) }) else { return Spelling::default() };
            if out.autocorrect.is_none() {
                out.autocorrect = fix;
            }
            lists.push(suggestions);
        }
        if lists.is_empty() {
            return out;
        }
        out.misspelled = true;
        // Not on Windows' list (short, especially in French), but only missing its accents: "tres"
        // becomes "très" when that's the best suggestion. Keeps a lowercase start: Windows offers
        // "Français" for "francais", which is right as it was typed, only without the cedilla.
        if out.autocorrect.is_none() {
            let lowercase = typed.chars().next().is_some_and(char::is_lowercase);
            for list in &lists {
                let Some(best) = list.first() else { continue };
                let mut fix = best.clone();
                if lowercase {
                    let mut chars = best.chars();
                    fix = chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default();
                }
                if fix != typed && super::fold_accents(&fix) == super::fold_accents(typed) {
                    out.autocorrect = Some(fix);
                    break;
                }
            }
        }
        // Taken in turn from each language, so one doesn't crowd the others out.
        let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
        for i in 0..longest {
            for list in &lists {
                if let Some(s) = list.get(i) {
                    if out.suggestions.len() < MAX_SUGGESTIONS && !out.suggestions.contains(s) {
                        out.suggestions.push(s.clone());
                    }
                }
            }
        }
        out
    }

    /// The misspellings one language finds in `text`, as (start, length) in UTF-16 units.
    unsafe fn ranges(checker: &ISpellChecker, text: &HSTRING) -> HashSet<(u32, u32)> {
        let mut out = HashSet::new();
        let Ok(errors) = (unsafe { checker.Check(text) }) else { return out };
        loop {
            let mut error: Option<ISpellingError> = None;
            if unsafe { errors.Next(&mut error) }.is_err() {
                break;
            }
            let Some(error) = error else { break };
            // Not "delete the repeated word": only words that aren't words.
            let action = unsafe { error.CorrectiveAction() };
            if !matches!(action, Ok(CORRECTIVE_ACTION_GET_SUGGESTIONS) | Ok(CORRECTIVE_ACTION_REPLACE)) {
                continue;
            }
            if let (Ok(start), Ok(len)) = unsafe { (error.StartIndex(), error.Length()) } {
                out.insert((start, len));
            }
        }
        out
    }

    pub fn errors(texts: &[String], languages: &[String]) -> Vec<Vec<(u32, u32)>> {
        let checkers = checkers(languages);
        texts
            .iter()
            .map(|text| {
                let text = HSTRING::from(text.as_str());
                let mut found: Option<HashSet<(u32, u32)>> = None;
                for checker in &checkers {
                    let here = unsafe { ranges(checker, &text) };
                    // Misspelled in every language: what they all find.
                    let both: HashSet<_> = match found {
                        None => here,
                        Some(before) => before.intersection(&here).copied().collect(),
                    };
                    let empty = both.is_empty();
                    found = Some(both);
                    if empty {
                        break;
                    }
                }
                let mut out: Vec<_> = found.unwrap_or_default().into_iter().collect();
                out.sort();
                out
            })
            .collect()
    }

    pub fn add(word: &str, languages: &[String]) {
        let word = HSTRING::from(word);
        for checker in checkers(languages) {
            let _ = unsafe { checker.Add(&word) };
        }
    }
}

/// Elsewhere the webview's own menu has the suggestions (the page leaves it to that).
#[cfg(not(windows))]
mod imp {
    use super::Spelling;
    pub fn check(_word: &str, _languages: &[String]) -> Spelling {
        Spelling::default()
    }
    pub fn add(_word: &str, _languages: &[String]) {}
    pub fn errors(texts: &[String], _languages: &[String]) -> Vec<Vec<(u32, u32)>> {
        vec![Vec::new(); texts.len()]
    }
}

// Off the UI thread: checking a long document takes a moment.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Whether `word` is misspelled in all of `languages` (BCP 47 tags; the user's Windows languages
/// come first, and those Windows can't check are skipped), with suggestions and its autocorrection.
#[tauri::command]
pub async fn spelling_check(word: String, languages: Vec<String>) -> Result<Spelling, String> {
    blocking(move || imp::check(&word, &languages)).await
}

/// The misspelled words in each text, as [start, length] in UTF-16 units (JavaScript's).
#[tauri::command]
pub async fn spelling_errors(texts: Vec<String>, languages: Vec<String>) -> Result<Vec<Vec<(u32, u32)>>, String> {
    blocking(move || imp::errors(&texts, &languages)).await
}

/// "Add to dictionary": the word counts as spelled right from now on, here and in other apps.
#[tauri::command]
pub async fn spelling_add(word: String, languages: Vec<String>) -> Result<(), String> {
    blocking(move || imp::add(&word, &languages)).await
}
