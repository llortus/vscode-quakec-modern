/**
 * Position in a text document.
 */
class Position {
    /**
     * Creates a position.
     *
     * @param {number} line
     * @param {number} character
     */
    constructor(line, character) {
        /**
         * Line position in a document (zero based).
         */
        this.line = line;

        /**
         * Character position in a document (zero based).
         */
        this.character = character;
    }

    /**
     * Checks Position object equality.
     *
     * @param {Position} lhs A Position object.
     * @param {Position} rhs A Position object.
     * @return {boolean} True if given Position objects are equal.
     */
    static isEqual(lhs, rhs) {
        return lhs.line === rhs.line && lhs.character === rhs.character;
    }

    /**
     * Compares two positions.
     *
     * @param {Position} lhs
     * @param {Position} rhs
     * @return {number} Negative if lhs is before rhs, positive if after, zero if equal.
     */
    static compare(lhs, rhs) {
        if (lhs.line !== rhs.line) {
            return lhs.line - rhs.line;
        }

        return lhs.character - rhs.character;
    }
}

/**
 * Range in a text document.
 */
class Range {
    /**
     * Creates a range with the given positions.
     *
     * @param {Position} start The range's start position
     * @param {Position} end The range's end position
     */
    constructor(start, end) {
        this.start = new Position(start.line, start.character);
        this.end = new Position(end.line, end.character);
    }

    /**
     * Checks for containment in the range. The end position is exclusive.
     *
     * @param {Position} position
     *
     * @returns {boolean} True if the given position is contained within the range.
     */
    contains(position) {
        return Position.compare(position, this.start) >= 0 && Position.compare(position, this.end) < 0;
    }
}

if (typeof require !== 'undefined' && typeof exports !== 'undefined') {
    exports.Position = Position;
    exports.Range = Range;
}
