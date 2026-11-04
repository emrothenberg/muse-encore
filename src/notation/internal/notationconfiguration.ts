// SPDX-License-Identifier: GPL-3.0-only
/**
 * C++ notation/internal/notationconfiguration.cpp: the preferences of the note input section, with C++'s defaults.
 * The application sets them from its settings.
 */
import { NoteEntryMethod } from '../../engraving/dom/input'

export class NotationConfiguration {
    // null: the default; not initialized with the enum because of the import cycles of the DOM modules
    private static s_defaultNoteInputMethod: NoteEntryMethod | null = null
    private static s_addAccidentalDotsArticulationsToNextNoteEntered = true
    private static s_useNoteInputCursorInInputByDuration = false

    static defaultNoteInputMethod(): NoteEntryMethod {
        return NotationConfiguration.s_defaultNoteInputMethod ?? NoteEntryMethod.BY_NOTE_NAME
    }

    static setDefaultNoteInputMethod(method: NoteEntryMethod): void {
        NotationConfiguration.s_defaultNoteInputMethod = method
    }

    static addAccidentalDotsArticulationsToNextNoteEntered(): boolean {
        return NotationConfiguration.s_addAccidentalDotsArticulationsToNextNoteEntered
    }

    static setAddAccidentalDotsArticulationsToNextNoteEntered(value: boolean): void {
        NotationConfiguration.s_addAccidentalDotsArticulationsToNextNoteEntered = value
    }

    static useNoteInputCursorInInputByDuration(): boolean {
        return NotationConfiguration.s_useNoteInputCursorInInputByDuration
    }

    static setUseNoteInputCursorInInputByDuration(use: boolean): void {
        NotationConfiguration.s_useNoteInputCursorInInputByDuration = use
    }
}
