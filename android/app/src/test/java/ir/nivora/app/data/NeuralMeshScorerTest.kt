package ir.nivora.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NeuralMeshScorerTest {
    private val profile = NeuralMeshProfile("reality-vision-8443", "Reality", "tcp", "vless://test")
    private val policy = NeuralMeshScoringPolicy(2, .25, .20, .20, .15, .20, 20_000.0, 20_000.0, 15_000.0)

    @Test fun rejectsProfileWithFewerThanTwoSuccessfulRounds() {
        val rounds = listOf(round(1, true), round(2, false), round(3, false))
        assertFalse(NeuralMeshScorer.result(profile, rounds, policy).accepted)
    }

    @Test fun acceptsTwoSuccessfulRoundsAndPenalisesTimeouts() {
        val clean = NeuralMeshScorer.result(profile, listOf(round(1, true), round(2, true), round(3, false)), policy)
        val timedOut = NeuralMeshScorer.result(profile, listOf(round(1, true, 1), round(2, true), round(3, false)), policy)
        assertTrue(clean.accepted)
        assertTrue(timedOut.score!! > clean.score!!)
    }

    private fun round(number: Int, success: Boolean, timeouts: Int = 0) = NeuralMeshRound(
        profile.id, number, success,
        if (success) 300 else null,
        if (success) 400 else null,
        if (success) 500 else null,
        if (success) 450 else null,
        if (success) 1_000 else null,
        if (success) 40.0 else null,
        0, timeouts, if (success) 0 else 1
    )
}
