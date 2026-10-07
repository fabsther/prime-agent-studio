package dev.primeagent.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RangeTest {
    private val etag = "\"size-mtime\""

    private fun decide(
        range: String? = "bytes 4-9/10",
        length: Long? = 6,
        offset: Long = 4,
        saved: String? = etag,
        response: String? = etag,
        total: Long? = 10,
        status: Int = 206,
    ) = RangeResume.decide(status, offset, range, length, saved, response, total)

    @Test fun matchingStrongValidatorAppendsOnlyRequestedTail() {
        assertEquals(RangeResume.Decision.Receive(true, 10, 6), decide())
    }

    @Test fun missingLengthIsSafeWithValidatedContentRange() {
        assertEquals(RangeResume.Decision.Receive(true, 10, 6), decide(length = null))
    }

    @Test fun fullResponseRestartsInsteadOfAppendingEvenWhenValidatorChanged() {
        assertEquals(RangeResume.Decision.Receive(false, 20, 20),
            decide(status = 200, range = null, length = 20, response = "\"new\""))
        assertEquals(RangeResume.Decision.Receive(false, null, null),
            decide(status = 200, range = null, length = null))
    }

    @Test fun rangeNotSatisfiableRestartsButNeverMarksPartialComplete() {
        assertEquals(RangeResume.Decision.Restart, decide(status = 416, range = "bytes */4", length = 0))
        assertTrue(decide(status = 416, offset = 0, range = "bytes */0", length = 0) is RangeResume.Decision.Reject)
    }

    @Test fun initial206MustCoverWholeFile() {
        assertEquals(RangeResume.Decision.Receive(false, 10, 10),
            decide(offset = 0, range = "bytes 0-9/10", length = 10, saved = null, response = null, total = null))
        assertTrue(decide(offset = 0, range = "bytes 1-9/10", length = 9) is RangeResume.Decision.Reject)
    }

    @Test fun malformedUnknownMultipartOrOverflowingRangesAreRejected() {
        val invalid = listOf(null, "", "bytes */10", "bytes 4-9/*", "bytes -4-9/10",
            "bytes 4-9/10,0-1/10", "items 4-9/10", "bytes 4-9/10 trailing",
            "bytes 4-9/99999999999999999999999999", "bytes 999999999999999999999999-9/10")
        invalid.forEach { range ->
            assertTrue("Should reject $range", decide(range = range) is RangeResume.Decision.Reject)
        }
    }

    @Test fun wrongStartInvertedEndOutOfBoundsAndIncompleteTailAreRejected() {
        listOf("bytes 3-9/10", "bytes 5-9/10", "bytes 4-3/10", "bytes 4-10/10",
            "bytes 4-8/10", "bytes 4-9/0").forEach { range ->
            assertTrue(range, decide(range = range) is RangeResume.Decision.Reject)
        }
    }

    @Test fun changedMissingOrWeakValidatorsMustNeverAppend() {
        val invalid = listOf(null, "W/\"size-mtime\"", "size-mtime", "\"new\"")
        invalid.forEach { validator ->
            assertTrue(decide(saved = validator) is RangeResume.Decision.Reject)
            assertTrue(decide(response = validator) is RangeResume.Decision.Reject)
        }
        assertTrue(decide(total = 11) is RangeResume.Decision.Reject)
    }

    @Test fun lengthMustMatchTheRangeExactly() {
        listOf(-1L, 0L, 5L, 7L).forEach { length ->
            assertTrue(decide(length = length) is RangeResume.Decision.Reject)
        }
    }

    @Test fun exactTwoGiBLimitUsesLongAndIsAllowed() {
        val max = RangeResume.MAX_BYTES
        assertEquals(2147483648L, max)
        assertEquals(RangeResume.Decision.Receive(false, max, max),
            decide(status = 200, offset = 0, length = max))
        assertEquals(RangeResume.Decision.Receive(true, max, 1),
            decide(offset = max - 1, range = "bytes ${max - 1}-${max - 1}/$max", length = 1, total = max))
    }

    @Test fun oversizedAndInvalidLocalOrRemoteSizesAreRejected() {
        val max = RangeResume.MAX_BYTES
        assertTrue(decide(status = 200, length = max + 1) is RangeResume.Decision.Reject)
        assertTrue(decide(range = "bytes 4-$max/${max + 1}", length = null) is RangeResume.Decision.Reject)
        assertTrue(decide(offset = -1) is RangeResume.Decision.Reject)
        assertTrue(decide(offset = max + 1) is RangeResume.Decision.Reject)
    }

    @Test fun emptyFullResponseIsAValidEmptyFile() {
        assertEquals(RangeResume.Decision.Receive(false, 0, 0), decide(status = 200, length = 0))
    }

    @Test fun unexpectedStatusesNeverAuthorizeBodyWrites() {
        listOf(201, 204, 301, 304, 400, 401, 403, 404, 500).forEach { status ->
            assertTrue(decide(status = status) is RangeResume.Decision.Reject)
        }
    }

    @Test fun rejectionsRetainTypedReasonsForLocalizedDetails() {
        assertEquals(RangeResume.Decision.Reject(FleetError.Download(DownloadError.INVALID_LOCAL_SIZE)), decide(offset = -1))
        assertEquals(RangeResume.Decision.Reject(FleetError.Download(DownloadError.INVALID_LENGTH)), decide(length = -1))
        assertEquals(RangeResume.Decision.Reject(FleetError.Download(DownloadError.INVALID_RANGE)), decide(range = "bad"))
        assertEquals(RangeResume.Decision.Reject(FleetError.Download(DownloadError.RANGE_MISMATCH)), decide(range = "bytes 3-9/10"))
        assertEquals(RangeResume.Decision.Reject(FleetError.Download(DownloadError.VALIDATOR_CHANGED)), decide(response = "\"new\""))
        assertEquals(RangeResume.Decision.Reject(FleetError.Download(DownloadError.LENGTH_MISMATCH)), decide(length = 5))
        assertEquals(RangeResume.Decision.Reject(FleetError.Http(401)), decide(status = 401))
    }

    @Test fun strongETagSyntaxExcludesWeakUnquotedAndControlCharacters() {
        assertTrue(RangeResume.strongETag(etag))
        assertTrue(RangeResume.strongETag("\"\""))
        listOf(null, "", "W/$etag", "plain", "\"broken", "\"a b\"", "\"a\n b\"",
            "\"a\"b\"", "\"a\u007fb\"", "\"a\u0100b\"").forEach { value ->
            assertFalse("Should reject $value", RangeResume.strongETag(value))
        }
    }
}
