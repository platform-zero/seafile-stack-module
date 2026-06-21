package org.webservices.testrunner.suites

import io.ktor.client.statement.*
import io.ktor.http.*
import org.webservices.testrunner.framework.*

suspend fun TestRunner.seafileFileManagementTests() = suite("Seafile File Management Tests") {
test("Seafile server is healthy") {
        val response = client.getRawResponse("${env.endpoints.seafile}/api2/ping/")
        response.status shouldBe HttpStatusCode.OK
        response.bodyAsText() shouldContain "pong"
    }

    test("Seafile web interface loads") {
        val response = client.getRawResponse("${env.endpoints.seafile}/")
        requireOkOrRedirectResponse(response, "Seafile web interface")
    }

    test("Seafile API endpoint responds") {
        val response = client.getRawResponse("${env.endpoints.seafile}/api2/ping/")
        
        if (response.status == HttpStatusCode.OK) {
            val body = response.bodyAsText()
            body shouldContain "pong"
        } else {
            fail("Unexpected Seafile API status: ${response.status}")
        }
    }
}
